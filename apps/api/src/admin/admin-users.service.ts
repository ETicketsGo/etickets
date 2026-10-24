import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, UserStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** What each action needs to know about who asked and from where. */
export interface AccountActionMeta {
  ip?: string | null;
}

/**
 * Stopping an account, and starting it again.
 *
 * ── WHY THIS DID NOT EXIST ─────────────────────────────────────────────────────────
 * `UserStatus.SUSPENDED` is refused on every request by JwtStrategy, which reads the status
 * from the database each time. But nothing ever WROTE it: support could see an abusive
 * account and had no way to stop it short of a database edit. And a stolen session could not
 * be ended at all except by the owner changing their password.
 *
 * ── WHAT EACH ACTION DOES ──────────────────────────────────────────────────────────
 *   suspend         status SUSPENDED and every refresh token revoked, together. The next
 *                   request with any access token is refused (JwtStrategy), and no session can
 *                   be renewed. A fresh password sign-in still returns tokens today
 *                   (AuthService.login does not read the status), but every request made
 *                   with them is refused the same way, so the account can do nothing.
 *   reinstate       status ACTIVE. Old sessions stay revoked: the person signs in again.
 *   revoke-sessions every refresh token revoked, status untouched. An access token already
 *                   issued keeps working until it expires (JWT_ACCESS_TTL, 15 minutes by
 *                   default), because access tokens are not looked up. Suspend is the action
 *                   that cuts off at once.
 *
 * ── GUARD RAILS ────────────────────────────────────────────────────────────────────
 * Nobody acts on their own account here: suspending yourself is a lock-out, and signing
 * yourself out everywhere is what "sign out" is for. A super admin can only be acted on by a
 * super admin - otherwise the holder of USER_SUSPEND could lock out the one person who could
 * take it away from them. Every action writes its audit row (actor, target, reason, client
 * address) in the SAME transaction as the change, so an action the log cannot record is not
 * made at all.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async suspend(actor: RequestUser, userId: string, reason: string, meta: AccountActionMeta = {}) {
    const why = reason.trim();
    if (!why) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why you are suspending this account. Support has to be able to read it later.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const target = await this.targetFor(actor, userId, 'suspend');
    if (target.status === UserStatus.DELETED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This account has been deleted. There is nothing to suspend.',
        HttpStatus.CONFLICT,
      );
    }
    if (target.status === UserStatus.SUSPENDED) {
      // Idempotent: a retry after a dropped response is told it worked, and writes nothing.
      return { userId, status: UserStatus.SUSPENDED, sessionsRevoked: 0 };
    }

    const done = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: UserStatus.SUSPENDED } });
      const { count } = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const entry: AuditEntry = {
        actorUserId: actor.id,
        action: 'USER_SUSPENDED',
        entityType: 'User',
        entityId: userId,
        metadata: {
          email: target.email,
          previousStatus: target.status,
          reason: why,
          sessionsRevoked: count,
          // Read by the ops alert: a suspended member of staff is mailed, a customer is not.
          backOffice: isBackOffice(target.roles),
        },
        ip: meta.ip ?? null,
      };
      await this.audit.recordInTransaction(tx, entry);
      return { count, entry };
    });
    // Committed: raised now, never for a suspension that rolled back.
    this.audit.afterCommit(done.entry);
    return { userId, status: UserStatus.SUSPENDED, sessionsRevoked: done.count };
  }

  async reinstate(
    actor: RequestUser,
    userId: string,
    reason: string | undefined,
    meta: AccountActionMeta = {},
  ) {
    const target = await this.targetFor(actor, userId, 'reinstate');
    if (target.status !== UserStatus.SUSPENDED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This account is ${target.status.toLowerCase()}, not suspended.`,
        HttpStatus.CONFLICT,
      );
    }
    const entry: AuditEntry = {
      actorUserId: actor.id,
      action: 'USER_REINSTATED',
      entityType: 'User',
      entityId: userId,
      metadata: {
        email: target.email,
        reason: reason?.trim() || null,
        backOffice: isBackOffice(target.roles),
      },
      ip: meta.ip ?? null,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: UserStatus.ACTIVE } });
      await this.audit.recordInTransaction(tx, entry);
    });
    this.audit.afterCommit(entry);
    return { userId, status: UserStatus.ACTIVE };
  }

  async revokeSessions(
    actor: RequestUser,
    userId: string,
    reason: string | undefined,
    meta: AccountActionMeta = {},
  ) {
    const target = await this.targetFor(actor, userId, 'revoke');
    const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        actorUserId: actor.id,
        action: 'USER_SESSIONS_REVOKED',
        entityType: 'User',
        entityId: userId,
        metadata: { email: target.email, reason: reason?.trim() || null, sessionsRevoked: count },
        ip: meta.ip ?? null,
      });
      return count;
    });
    return { userId, sessionsRevoked };
  }

  /** The account being acted on, after the rules that apply to every action here. */
  private async targetFor(
    actor: RequestUser,
    userId: string,
    action: 'suspend' | 'reinstate' | 'revoke',
  ) {
    if (userId === actor.id && action !== 'reinstate') {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        action === 'suspend'
          ? 'You cannot suspend your own account.'
          : 'To end your own sessions, sign out. This action is for other accounts.',
        HttpStatus.FORBIDDEN,
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roles: true, status: true },
    });
    if (!target) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Account not found.', HttpStatus.NOT_FOUND);
    }
    if (
      (target.roles as string[]).includes(Role.SUPER_ADMIN) &&
      !actor.roles.includes(Role.SUPER_ADMIN)
    ) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only a super admin can do this to a super admin account.',
        HttpStatus.FORBIDDEN,
      );
    }
    return target;
  }
}

/** Holds a back-office role: suspending it changes who can run the platform. */
function isBackOffice(roles: readonly string[]): boolean {
  return roles.includes(Role.ADMIN) || roles.includes(Role.SUPER_ADMIN);
}
