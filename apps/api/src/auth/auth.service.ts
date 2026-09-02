import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthTokens } from '@eticketsgo/shared-types';
import { Role } from '@eticketsgo/shared-types';
import type { LoginInput, RegisterInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { NotificationType } from '@eticketsgo/shared-types';
import type { AccessTokenPayload } from './jwt.strategy';

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

/**
 * How long a reset link lives: thirty minutes.
 *
 * Far shorter than an invitation's seven days, and deliberately so. An invitation waits for
 * somebody to get round to joining; a reset is acted on within minutes of asking, and a link
 * left sitting in a mailbox is a standing key to the account.
 */
const RESET_TTL_MINUTES = 30;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async register(input: RegisterInput, meta: RequestMeta): Promise<AuthTokens> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppException(
        ErrorCodes.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        roles: [Role.CUSTOMER],
      },
    });
    return this.issueTokens(user.id, user.email, user.fullName, user.roles as Role[], meta);
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      // Forensic trail for credential-stuffing / brute-force (audit is fail-safe).
      await this.audit.record({
        actorUserId: user?.id ?? null,
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: { email: input.email, reason: user ? 'bad_password' : 'unknown_user' },
        ip: meta.ip ?? null,
      });
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'Incorrect email or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.audit.record({
      actorUserId: user.id,
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip ?? null,
    });
    return this.issueTokens(user.id, user.email, user.fullName, user.roles as Role[], meta);
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!record || record.expiresAt < new Date()) {
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // Reuse detection: a recognized-but-already-revoked token is a token that was
    // already rotated (or explicitly logged out). Presenting it again is a replay
    // and a compromise signal — the same secret is now in two places. Treat the
    // whole family as burned: revoke every still-active refresh token for the user
    // (forcing a fresh sign-in everywhere), then reject.
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Replay of a rotated/revoked token = compromise signal; record the family burn.
      await this.audit.record({
        actorUserId: record.userId,
        action: 'AUTH_TOKEN_REUSE_DETECTED',
        entityType: 'RefreshToken',
        entityId: record.id,
        metadata: { familyRevoked: true },
        ip: meta.ip ?? null,
      });
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) {
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Session invalid.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Rotate: revoke the used token, then issue a fresh pair.
    const tokens = await this.issueTokens(
      user.id,
      user.email,
      user.fullName,
      user.roles as Role[],
      meta,
    );
    const replacement = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(tokens.refreshToken) },
    });
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedByTokenId: replacement?.id },
    });
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  /**
   * Retention/hygiene sweep: delete refresh tokens that are safely dead — expired
   * past a grace period, or revoked more than `graceDays` ago. Keeps the PII-bearing
   * (ip/userAgent) table bounded and drops data past any lawful basis. Idempotent.
   */
  async pruneExpiredRefreshTokens(now: Date = new Date(), graceDays = 7): Promise<number> {
    const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
    return count;
  }

  /**
   * Complete a phone sign-in, once the code has already been proved.
   *
   * Deliberately takes a user id rather than a phone and a code: verifying the code is the
   * OTP service's job, and minting a session is this one's. Keeping the split means phone
   * sign-in produces exactly the same tokens, with the same claims and the same refresh
   * record, as email sign-in — rather than a second session path that drifts.
   */
  async completePhoneSignIn(userId: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'That code is not valid. Ask for a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.issueTokens(user.id, user.email, user.fullName, user.roles as Role[], meta);
  }

  private async issueTokens(
    userId: string,
    email: string,
    fullName: string,
    roles: Role[],
    meta: RequestMeta,
  ): Promise<AuthTokens> {
    const payload: AccessTokenPayload = { sub: userId, email, name: fullName, roles };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // @nestjs/jwt v11 types expiresIn as ms' `StringValue` template-literal union; a config
      // string ('900s' default) is valid at runtime but not provably assignable, so cast to the
      // exact option type. Behaviour and the TTL source are unchanged.
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '900s') as JwtSignOptions['expiresIn'],
    });

    const refreshToken = randomBytes(48).toString('hex');
    const ttlDays = parseTtlDays(this.config.get<string>('JWT_REFRESH_TTL', '30d'));
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Begin a password reset.
   *
   * -- WHY THE ANSWER IS ALWAYS THE SAME ---------------------------------------------
   * Unauthenticated, and it takes an email somebody merely typed. If it answered
   * differently for a known and an unknown address it would be a free tool for discovering
   * who has an account here — and on a ticketing platform, who bought tickets to what.
   *
   * So it returns the same acknowledgement either way and says nothing a requester could
   * use. The person who actually owns the address learns the outcome from their inbox,
   * which is the only place it belongs.
   *
   * -- AND WHY THE LINK IS NEVER RETURNED --------------------------------------------
   * The invitation flow hands its link back to the caller, because there the caller is an
   * authenticated owner inviting somebody deliberately and email is not configured
   * everywhere. Here the caller is anonymous. Returning the link would not be a
   * convenience; it would be account takeover with extra steps.
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, status: true },
    });

    // No account, or a disabled one: stop silently. The caller cannot tell the difference.
    if (!user || user.status !== 'ACTIVE') return;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(token);

    await this.prisma.$transaction(async (tx) => {
      /*
        Any earlier link is spent first. Two live reset links for one account means an old
        one — possibly already forwarded or leaked — still opens the door after the owner
        has asked for a fresh one.
      */
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
          requestedIp: meta.ip ?? null,
        },
      });
    });

    await this.notifications.send({
      type: NotificationType.PASSWORD_RESET_REQUESTED,
      userId: user.id,
      toEmail: user.email,
      payload: {
        link: `${this.resetBaseUrl()}/reset-password?token=${token}`,
        minutes: String(RESET_TTL_MINUTES),
      },
    });

    await this.audit.record({
      actorUserId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      metadata: { ip: meta.ip ?? null },
    });
  }

  /**
   * Finish a password reset.
   *
   * Every session is destroyed, not just the current one. If the reset was requested
   * because somebody else got in, leaving their refresh token alive would mean the password
   * change accomplished nothing — they would keep the account while the owner believed they
   * had recovered it.
   */
  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: { select: { id: true, email: true, status: true } } },
    });

    /*
      Unknown, spent and expired are answered as one. Telling them apart would tell somebody
      holding a stolen link whether it is worth chasing a fresher one.
    */
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This reset link is no longer valid. Request a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (row.user.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This account cannot be used. Contact support.',
        HttpStatus.FORBIDDEN,
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      await tx.passwordResetToken.updateMany({
        where: { userId: row.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      /*
        An unclaimed invitation is completed by the same act.

        Somebody invited but never activated holds an account they cannot sign into. What an
        invitation asks for is proof of control of the address, and a reset link sent to that
        address is exactly that proof. Refusing here would leave them with a working password
        and still no access — the dead end the invitation work existed to remove, rebuilt.
      */
      const pending = await tx.accountInvitation.findFirst({
        where: { userId: row.userId, acceptedAt: null },
      });
      if (pending) {
        await tx.accountInvitation.update({
          where: { id: pending.id },
          data: { acceptedAt: new Date(), tokenHash: `accepted:${pending.id}` },
        });
        if (pending.organizationMemberId) {
          await tx.organizationMember.update({
            where: { id: pending.organizationMemberId },
            data: { status: 'ACTIVE' },
          });
        }
      }
    });

    /*
      Told afterwards, always — even though they just did it themselves. For the owner it is
      a receipt; for somebody whose account was taken it is the only warning they get.
    */
    await this.notifications.send({
      type: NotificationType.PASSWORD_CHANGED,
      userId: row.userId,
      toEmail: row.user.email,
      payload: {},
    });

    await this.audit.record({
      actorUserId: row.userId,
      action: 'PASSWORD_RESET_COMPLETED',
      entityType: 'User',
      entityId: row.userId,
      metadata: { ip: meta.ip ?? null },
    });
  }

  /**
   * Where a reset link points.
   *
   * The CUSTOMER site, because every account exists there whatever else it is — an organizer
   * and a back-office administrator sign in with the same account, and there is no way to
   * know from an email address which console the person thinks of as theirs.
   *
   * Same fail-loud rule as the invitation links: a localhost fallback is right on a laptop
   * and a silently dead link anywhere else, so outside LOCAL/DEV this refuses and names the
   * variable. Keyed on APP_ENV because QA and UAT both run NODE_ENV=production.
   */
  private resetBaseUrl(): string {
    const configured = this.config.get<string>('CUSTOMER_WEB_URL')?.trim();
    if (configured) return configured.replace(/\/+$/, '');

    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    if (['LOCAL', 'DEV'].includes(appEnv)) return 'http://localhost:3000';

    throw new AppException(
      ErrorCodes.INTERNAL,
      'Password reset is unavailable: CUSTOMER_WEB_URL is not configured, so the link would point at localhost.',
      HttpStatus.INTERNAL_SERVER_ERROR,
      { appEnv },
    );
  }
}

function parseTtlDays(ttl: string): number {
  const match = /^(\d+)\s*d$/.exec(ttl.trim());
  return match ? Number(match[1]) : 30;
}
