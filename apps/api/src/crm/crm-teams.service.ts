import { HttpStatus, Injectable } from '@nestjs/common';
import { AdminPermission, Role, type CrmTeamRole } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { CrmScopeService } from './crm-scope.service';

/**
 * Who is on which acquisition team.
 *
 * Team membership is SCOPE: it decides which country's prospects somebody sees. It is not a
 * second permission system - nobody gets a capability here. A person must already hold
 * CRM_AGENT (granted on Staff & duties by whoever holds ADMIN_MANAGE) before they can join a
 * team, and CRM_MANAGER before they can be a team's manager.
 *
 * Rules, all checked here so they hold for every caller:
 *   - Nobody changes their own membership (the same rule as Staff & duties: no self-escalation).
 *   - A manager of a team may add or remove AGENTS in that team.
 *   - Only a super admin creates teams, appoints or removes a MANAGER.
 */
@Injectable()
export class CrmTeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopes: CrmScopeService,
  ) {}

  /** The caller's own CRM standing, so the console shows only what they can use. */
  async me(actor: RequestUser) {
    const scope = await this.scopes.resolve(actor);
    const teams = await this.prisma.crmTeam.findMany({
      where: { id: { in: [...scope.managedTeamIds, ...scope.agentTeamIds] } },
      orderBy: { key: 'asc' },
      select: { id: true, key: true, name: true, country: true, active: true },
    });
    return {
      userId: actor.id,
      isSuperAdmin: scope.isSuperAdmin,
      holdsManager: scope.holdsManager,
      teams: teams.map((t) => ({ ...t, manages: scope.managedTeamIds.includes(t.id) })),
    };
  }

  /** Teams the caller belongs to; members are listed only for the teams they manage. */
  async list(actor: RequestUser) {
    const scope = await this.scopes.resolve(actor);
    const visible = [...scope.managedTeamIds, ...scope.agentTeamIds];
    const teams = await this.prisma.crmTeam.findMany({
      where: { id: { in: visible } },
      orderBy: { key: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        country: true,
        active: true,
        members: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            createdAt: true,
            user: { select: { id: true, fullName: true, email: true, status: true, roles: true } },
          },
        },
      },
    });
    const grants = await this.prisma.adminGrant.findMany({
      where: {
        userId: { in: teams.flatMap((t) => t.members.map((m) => m.user.id)) },
        permission: { in: [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER] },
      },
      select: { userId: true, permission: true },
    });
    const holds = (userId: string, roles: string[], p: string) =>
      roles.includes(Role.SUPER_ADMIN) ||
      grants.some((g) => g.userId === userId && g.permission === p);
    return teams.map(({ members, ...t }) => {
      const manages = scope.managedTeamIds.includes(t.id);
      return {
        ...t,
        manages,
        members: manages
          ? members.map((m) => ({
              userId: m.user.id,
              fullName: m.user.fullName,
              email: m.user.email,
              status: m.user.status,
              role: m.role,
              since: m.createdAt,
              holdsAgent: holds(m.user.id, m.user.roles, AdminPermission.CRM_AGENT),
              holdsManager: holds(m.user.id, m.user.roles, AdminPermission.CRM_MANAGER),
            }))
          : // An agent sees who their manager is, nothing about the rest of the team.
            members
              .filter((m) => m.role === 'MANAGER' || m.user.id === actor.id)
              .map((m) => ({ userId: m.user.id, fullName: m.user.fullName, role: m.role })),
      };
    });
  }

  /** Back-office accounts holding CRM_AGENT who are not yet on this team. */
  async candidates(actor: RequestUser, teamId: string) {
    const scope = await this.scopes.resolve(actor);
    if (!this.scopes.managesTeam(scope, teamId)) throw this.scopes.managerOnly('add team members');
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        roles: { hasSome: [Role.ADMIN, Role.SUPER_ADMIN] },
        adminGrants: { some: { permission: AdminPermission.CRM_AGENT } },
        crmTeamMemberships: { none: { teamId } },
      },
      orderBy: { fullName: 'asc' },
      take: 100,
      select: {
        id: true,
        fullName: true,
        email: true,
        adminGrants: { select: { permission: true } },
      },
    });
    return users.map(({ adminGrants, ...u }) => ({
      ...u,
      holdsManager: adminGrants.some((g) => g.permission === AdminPermission.CRM_MANAGER),
    }));
  }

  async createTeam(actor: RequestUser, input: { key: string; name: string; country: string }) {
    if (!actor.roles.includes(Role.SUPER_ADMIN)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only a super admin can create an acquisition team.',
        HttpStatus.FORBIDDEN,
      );
    }
    const exists = await this.prisma.crmTeam.findUnique({ where: { key: input.key } });
    if (exists) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'A team with that key exists.',
        HttpStatus.CONFLICT,
      );
    }
    const team = await this.prisma.crmTeam.create({ data: input });
    await this.audit.record({
      actorUserId: actor.id,
      action: 'CRM_TEAM_CREATED',
      entityType: 'CrmTeam',
      entityId: team.id,
      metadata: { key: team.key, country: team.country },
    });
    return team;
  }

  async setMember(actor: RequestUser, teamId: string, userId: string, role: CrmTeamRole) {
    if (userId === actor.id) throw ownMembership();
    const scope = await this.scopes.resolve(actor);
    const team = await this.prisma.crmTeam.findUnique({ where: { id: teamId } });
    if (!team || !this.scopes.managesTeam(scope, teamId))
      throw this.scopes.managerOnly('change who is on it');
    const existing = await this.prisma.crmTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    // Appointing a manager - or changing one - is a super admin's decision.
    if ((role === 'MANAGER' || existing?.role === 'MANAGER') && !scope.isSuperAdmin) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only a super admin can appoint or change a team manager.',
        HttpStatus.FORBIDDEN,
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roles: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }
    const held = await this.scopes.heldPermissions(target.id, target.roles);
    const backOffice = target.roles.includes(Role.ADMIN) || target.roles.includes(Role.SUPER_ADMIN);
    const needs = role === 'MANAGER' ? AdminPermission.CRM_MANAGER : AdminPermission.CRM_AGENT;
    if (!backOffice || !held.has(AdminPermission.CRM_AGENT) || !held.has(needs)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        role === 'MANAGER'
          ? 'Give this person the Acquisition manager duty on Staff & duties first.'
          : 'Give this person the Acquisition agent duty on Staff & duties first.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const entry: AuditEntry = {
      actorUserId: actor.id,
      action: existing ? 'CRM_TEAM_MEMBER_CHANGED' : 'CRM_TEAM_MEMBER_ADDED',
      entityType: 'CrmTeam',
      entityId: teamId,
      metadata: { userId, role, before: existing?.role ?? null },
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.crmTeamMember.upsert({
        where: { teamId_userId: { teamId, userId } },
        create: { teamId, userId, role, addedByUserId: actor.id },
        update: { role },
      });
      await this.audit.recordInTransaction(tx, entry);
    });
    this.audit.afterCommit(entry);
    return { teamId, userId, role };
  }

  async removeMember(actor: RequestUser, teamId: string, userId: string) {
    if (userId === actor.id) throw ownMembership();
    const scope = await this.scopes.resolve(actor);
    if (!this.scopes.managesTeam(scope, teamId))
      throw this.scopes.managerOnly('change who is on it');
    const existing = await this.prisma.crmTeamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!existing) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Not a member of this team.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.role === 'MANAGER' && !scope.isSuperAdmin) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only a super admin can remove a team manager.',
        HttpStatus.FORBIDDEN,
      );
    }
    const entry: AuditEntry = {
      actorUserId: actor.id,
      action: 'CRM_TEAM_MEMBER_REMOVED',
      entityType: 'CrmTeam',
      entityId: teamId,
      metadata: { userId, role: existing.role },
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.crmTeamMember.delete({ where: { id: existing.id } });
      await this.audit.recordInTransaction(tx, entry);
    });
    this.audit.afterCommit(entry);
    // Their leads stay assigned to them (and out of their sight) until a manager reassigns.
    const stillAssigned = await this.prisma.crmLead.count({
      where: { teamId, assignedToUserId: userId, archivedAt: null },
    });
    return { teamId, userId, removed: true, stillAssigned };
  }
}

function ownMembership(): AppException {
  return new AppException(
    ErrorCodes.FORBIDDEN,
    'You cannot change your own team membership. Ask another manager or a super admin.',
    HttpStatus.FORBIDDEN,
  );
}
