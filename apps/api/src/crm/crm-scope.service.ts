import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPermission, Role, permissionsFor } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * WHICH leads a member of the acquisition desk may see and change.
 *
 * ── TWO QUESTIONS, ANSWERED SEPARATELY ─────────────────────────────────────────────
 * The capability (CRM_AGENT / CRM_MANAGER, an AdminGrant) says what KIND of thing somebody
 * may do; `AdminPermissionGuard` has already checked it before any of this runs. The team
 * membership says WHERE: which country's prospects. Effective power is both together:
 *
 *   - In a team where the person is MANAGER and holds CRM_MANAGER: every lead in that team.
 *   - In any other team they belong to: only the leads assigned to them.
 *   - A team they do not belong to: nothing, whatever they hold.
 *   - A super admin (by role, like everywhere else) sees every team.
 *
 * So a MANAGER row without the capability manages nothing, and the capability without the
 * row manages nothing either. Both are read from the database on every request, as the guard
 * reads grants, so taking somebody off a team works on their very next click.
 *
 * ── REFUSING WITHOUT CONFIRMING ────────────────────────────────────────────────────
 * A lead outside the caller's scope is answered with 404, exactly as one that does not exist,
 * so an agent cannot learn by probing ids which leads other agents or countries hold.
 */
export interface CrmScope {
  actorId: string;
  isSuperAdmin: boolean;
  /** Holds the CRM_MANAGER capability (or is a super admin). */
  holdsManager: boolean;
  /** Teams in which the caller sees and runs every lead. */
  managedTeamIds: string[];
  /** Teams in which the caller sees only the leads assigned to them. */
  agentTeamIds: string[];
}

export interface ScopedLead {
  id: string;
  teamId: string;
  assignedToUserId: string | null;
}

@Injectable()
export class CrmScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async heldPermissions(userId: string, roles: readonly string[]): Promise<Set<AdminPermission>> {
    const rows = await this.prisma.adminGrant.findMany({
      where: { userId },
      select: { permission: true },
    });
    return permissionsFor(
      roles,
      rows.map((r) => r.permission as AdminPermission),
    );
  }

  async resolve(actor: RequestUser): Promise<CrmScope> {
    const isSuperAdmin = actor.roles.includes(Role.SUPER_ADMIN);
    const held = await this.heldPermissions(actor.id, actor.roles);
    const holdsManager = held.has(AdminPermission.CRM_MANAGER);
    if (isSuperAdmin) {
      const teams = await this.prisma.crmTeam.findMany({ select: { id: true } });
      return {
        actorId: actor.id,
        isSuperAdmin,
        holdsManager: true,
        managedTeamIds: teams.map((t) => t.id),
        agentTeamIds: [],
      };
    }
    const memberships = await this.prisma.crmTeamMember.findMany({
      where: { userId: actor.id, team: { active: true } },
      select: { teamId: true, role: true },
    });
    const managedTeamIds = memberships
      .filter((m) => m.role === 'MANAGER' && holdsManager)
      .map((m) => m.teamId);
    const agentTeamIds = memberships
      .filter((m) => !managedTeamIds.includes(m.teamId))
      .map((m) => m.teamId);
    return { actorId: actor.id, isSuperAdmin, holdsManager, managedTeamIds, agentTeamIds };
  }

  /** The leads this scope may see, as a Prisma filter. */
  leadWhere(scope: CrmScope): Prisma.CrmLeadWhereInput {
    return {
      OR: [
        { teamId: { in: scope.managedTeamIds } },
        { teamId: { in: scope.agentTeamIds }, assignedToUserId: scope.actorId },
      ],
    };
  }

  /** The same filter for raw SQL reports, against a lead aliased as `alias`. */
  leadSql(scope: CrmScope, alias = 'l'): Prisma.Sql {
    const a = Prisma.raw(`"${alias}"`);
    return Prisma.sql`(${a}."teamId" = ANY(${scope.managedTeamIds}::text[]) OR (${a}."teamId" = ANY(${scope.agentTeamIds}::text[]) AND ${a}."assignedToUserId" = ${scope.actorId}))`;
  }

  inTeam(scope: CrmScope, teamId: string): boolean {
    return scope.managedTeamIds.includes(teamId) || scope.agentTeamIds.includes(teamId);
  }

  managesTeam(scope: CrmScope, teamId: string): boolean {
    return scope.managedTeamIds.includes(teamId);
  }

  canSee(scope: CrmScope, lead: ScopedLead): boolean {
    return (
      this.managesTeam(scope, lead.teamId) ||
      (scope.agentTeamIds.includes(lead.teamId) && lead.assignedToUserId === scope.actorId)
    );
  }

  /** A refusal that does not confirm the lead exists. */
  notFound(): AppException {
    return new AppException(ErrorCodes.NOT_FOUND, 'Lead not found.', HttpStatus.NOT_FOUND);
  }

  managerOnly(action: string): AppException {
    return new AppException(
      ErrorCodes.FORBIDDEN,
      `Only a manager of this team can ${action}.`,
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Whether `userId` may hold work in `teamId`: a member of the team who currently holds
   * CRM_AGENT (or is a super admin). Read now, so a revoked duty cannot be handed new work.
   */
  async assertAssignable(teamId: string, userId: string): Promise<void> {
    const member = await this.prisma.crmTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { user: { select: { roles: true, status: true } } },
    });
    const ok =
      !!member &&
      member.user.status === 'ACTIVE' &&
      (await this.heldPermissions(userId, member.user.roles)).has(AdminPermission.CRM_AGENT);
    if (!ok) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'That person is not an active member of this team with the Acquisition agent duty.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
