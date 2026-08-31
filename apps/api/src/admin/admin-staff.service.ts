import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import {
  ADMIN_PRESETS,
  ALL_ADMIN_PERMISSIONS,
  AdminPermission,
  Role,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * Who works in the back office, and what each of them may do.
 *
 * Every change here is audited with the before and after set. Splitting duties is only
 * worth doing if somebody can later reconstruct who held which duty on the day something
 * went wrong — a permission table that only answers "now" throws away the question actually
 * asked during an investigation.
 */
@Injectable()
export class AdminStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invitations: OrganizationsService,
  ) {}

  /** The catalogue and the ready-made bundles, so the console need not hardcode either. */
  catalogue() {
    return {
      permissions: ALL_ADMIN_PERMISSIONS,
      presets: Object.entries(ADMIN_PRESETS).map(([key, p]) => ({ key, ...p })),
    };
  }

  /** Back-office accounts with what each currently holds. */
  async list() {
    const users = await this.prisma.user.findMany({
      where: { roles: { hasSome: [Role.ADMIN, Role.SUPER_ADMIN] } },
      select: {
        id: true,
        email: true,
        fullName: true,
        roles: true,
        status: true,
        adminGrants: { select: { permission: true, createdAt: true, note: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      status: u.status,
      isSuperAdmin: u.roles.includes(Role.SUPER_ADMIN),
      // Stated rather than left to the reader: a super admin's empty grant list does NOT
      // mean they can do nothing, and a console that showed it that way would mislead.
      permissions: u.roles.includes(Role.SUPER_ADMIN)
        ? ALL_ADMIN_PERMISSIONS
        : u.adminGrants.map((g) => g.permission as AdminPermission),
    }));
  }

  /**
   * Replace what one account may do.
   *
   * Set semantics rather than add/remove: the caller sends the complete list they intend,
   * which is the only version that is safe to retry. An "add one" endpoint invites a UI
   * that computes a diff, and a diff computed against a stale read silently reinstates a
   * capability somebody else just revoked.
   */
  async setPermissions(
    actor: RequestUser,
    userId: string,
    permissions: AdminPermission[],
    note?: string,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roles: true, adminGrants: { select: { permission: true } } },
    });
    if (!target) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }
    const backOffice: string[] = [Role.ADMIN, Role.SUPER_ADMIN];
    if (!target.roles.some((r) => backOffice.includes(r))) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'That account is not a back-office account.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (target.roles.includes(Role.SUPER_ADMIN)) {
      // A super admin holds everything by role. Writing grants for one would imply the set
      // is editable, and someone would later "tidy up" a super admin into having none.
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A super admin already holds every permission; there is nothing to grant.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const wanted = [...new Set(permissions)].filter((p) =>
      (ALL_ADMIN_PERMISSIONS as string[]).includes(p),
    );
    const before = target.adminGrants.map((g) => g.permission).sort();

    await this.prisma.$transaction(async (tx) => {
      await tx.adminGrant.deleteMany({ where: { userId } });
      if (wanted.length > 0) {
        await tx.adminGrant.createMany({
          data: wanted.map((permission) => ({
            userId,
            permission,
            grantedByUserId: actor.id,
            note,
          })),
        });
      }
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'ADMIN_PERMISSIONS_CHANGED',
      entityType: 'User',
      entityId: userId,
      // Both sides recorded: "what changed" is the question, and an after-only entry cannot
      // answer it once the row has been overwritten again.
      metadata: { email: target.email, before, after: [...wanted].sort(), note: note ?? null },
    });

    return { userId, permissions: wanted };
  }

  /**
   * Turn an existing account into a back-office one.
   *
   * Deliberately does not create the person. An admin account is a real human who already
   * has a login; minting credentials here would mean this service handing out passwords,
   * and a password created by an administrator is one the account holder never chose.
   */
  async grantAdminRole(actor: RequestUser, userId: string, permissions: AdminPermission[]) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roles: true },
    });
    if (!target) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }
    if (!target.roles.includes(Role.ADMIN)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { roles: { set: [...target.roles, Role.ADMIN] } },
      });
      await this.audit.record({
        actorUserId: actor.id,
        action: 'ADMIN_ROLE_GRANTED',
        entityType: 'User',
        entityId: userId,
        metadata: { email: target.email },
      });
    }
    return this.setPermissions({ ...actor }, userId, permissions);
  }

  /**
   * Add somebody to the back office who has not signed up yet.
   *
   * -- WHY THIS DID NOT EXIST -------------------------------------------------------
   * The staff screen would only search accounts that ALREADY existed, and said why:
   * "minting credentials here would mean this screen handing out passwords that the
   * account holder never picked and an administrator has seen." That was a good reason.
   *
   * It stopped being a reason when invitations arrived. The invitee sets their own
   * password through a single-use link; no administrator ever sees a credential, and the
   * account cannot be signed into until they do. So the limitation is lifted by reusing
   * that mechanism rather than by relaxing the principle behind it.
   *
   * -- WHAT IS GRANTED, AND WHEN ----------------------------------------------------
   * The duties are granted NOW, not on acceptance, and that is safe because an unaccepted
   * account carries a password hash bcrypt can never match — it holds capabilities it has
   * no way to exercise. Granting on acceptance instead would mean the permissions an
   * administrator chose could silently differ from the ones that eventually landed, days
   * later, with nobody watching.
   */
  async inviteStaff(actor: RequestUser, email: string, permissions: AdminPermission[]) {
    const normalised = email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email: normalised } });
    if (existing) {
      /*
        Refused rather than quietly promoted. Somebody who already has an account can be
        found by the search this screen already offers, and granting back-office access to
        an address that turns out to belong to an existing customer — because of a typo —
        should require seeing who they are first.
      */
      throw new AppException(
        ErrorCodes.CONFLICT,
        'That address already has an ETicketsGo account. Search for them instead, so you can see who you are granting access to.',
        HttpStatus.CONFLICT,
      );
    }

    const user = await this.prisma.user.create({
      data: {
        email: normalised,
        fullName: normalised.split('@')[0],
        // Same placeholder the organization invite path writes: unmatched by bcrypt, so the
        // account is inert until the invitation is accepted and a real password chosen.
        passwordHash: `invite-pending$${await bcrypt.hash(randomBytes(32).toString('hex'), 10)}`,
        roles: [Role.CUSTOMER],
      },
    });

    await this.grantAdminRole(actor, user.id, permissions);
    // The ADMIN console: a back-office invitee has no business in the organizer app.
    const inviteUrl = await this.invitations.issueInvitation(user.id, actor.id, undefined, 'admin');

    await this.audit.record({
      actorUserId: actor.id,
      action: 'BACK_OFFICE_INVITED',
      entityType: 'User',
      entityId: user.id,
      metadata: { email: normalised, permissions },
    });

    return { id: user.id, email: normalised, inviteUrl };
  }

  /** Remove back-office access entirely: the role and every capability with it. */
  async revokeAdminRole(actor: RequestUser, userId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roles: true },
    });
    if (!target) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }
    if (target.roles.includes(Role.SUPER_ADMIN)) {
      /*
        Refused, and this is the important one.

        An installation with no super admin is one where nobody can appoint another, which
        makes the permission system unrepairable from inside the product. Removing the last
        one has to be a deliberate database operation by somebody who knows what they are
        doing, not a button.
      */
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A super admin cannot be removed here. Demote them at the database level, deliberately.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (target.id === actor.id) {
      // Locking yourself out mid-task is a support ticket, not a feature.
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'You cannot remove your own back-office access.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.adminGrant.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { roles: { set: target.roles.filter((r) => r !== Role.ADMIN) } },
      });
    });
    await this.audit.record({
      actorUserId: actor.id,
      action: 'ADMIN_ROLE_REVOKED',
      entityType: 'User',
      entityId: userId,
      metadata: { email: target.email },
    });
    return { userId, removed: true };
  }
}
