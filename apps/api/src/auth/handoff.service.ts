import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthTokens, MfaChallengeResponse } from '@eticketsgo/shared-types';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AuthService } from './auth.service';
import { hashCode } from './handoff-revocation';

export { hashCode, revokeHandoffsForUser } from './handoff-revocation';

/**
 * Carrying a signed-in storefront session to the organizer console, without a token in a URL.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The storefront and the console are different origins, so a session in one is invisible to
 * the other. The account menu showed a phone-registered organizer "Organizer console - <their
 * organization>" and sent them to a console sign-in page that offered only an email and a
 * password - credentials a phone-only account has never had. The organization was theirs, the
 * server said so, and there was no way in.
 *
 * ── THE BRIDGE ─────────────────────────────────────────────────────────────────────
 *   1. The storefront, signed in, asks `POST /auth/handoff` for a code for the `organizer`
 *      audience. The server re-checks, now, that the account is active and holds an ACTIVE
 *      organizer seat in an organization that is not suspended.
 *   2. The code is 32 random bytes, stored only as its SHA-256, valid for 60 seconds, for one
 *      audience, once. The browser carries it to the console in the URL FRAGMENT - which is
 *      never sent to any server, not even the console's - and the console removes it from the
 *      address bar and history before doing anything else.
 *   3. The console trades it at `POST /auth/handoff/exchange` for an ordinary session of its
 *      own: a new refresh token under the same rotation rules as every sign-in, through the
 *      same gate (`signInOrChallenge`) - so a back-office account gets its second-factor
 *      challenge here exactly as it would on the password route, never tokens.
 *
 * The code is not a token: it cannot call any API, it dies in a minute, and the first exchange
 * spends it. A sign-out on the storefront revokes any code that session's account has
 * outstanding (`revokeForUser`).
 */

/** How long a handoff code lives. Long enough for one redirect on a slow phone; no longer. */
export const HANDOFF_TTL_SECONDS = 60;

/** The consoles a code may be minted for. Only the organizer console today. */
export const HANDOFF_AUDIENCES = ['organizer'] as const;
export type HandoffAudience = (typeof HANDOFF_AUDIENCES)[number];

/** The seats that open the organizer console. */
const ORGANIZER_SEAT_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

/** Why an account may not be carried across. Distinct audit reasons, one public answer each. */
type Refusal = 'inactive_user' | 'no_membership' | 'organization_suspended';

@Injectable()
export class AuthHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Mint a code for the signed-in account. Authorization is read from the DATABASE, not the
   * token: a seat removed a second ago, or an account suspended, is refused now.
   */
  async create(
    userId: string,
    audience: HandoffAudience,
    meta: RequestMeta,
  ): Promise<{ code: string; expiresInSeconds: number }> {
    const refusal = await this.refusalFor(userId);
    if (refusal) {
      await this.audit.record({
        actorUserId: userId,
        action: 'AUTH_HANDOFF_REFUSED',
        entityType: 'User',
        entityId: userId,
        metadata: { audience, stage: 'create', reason: refusal },
        ip: meta.ip ?? null,
      });
      throw refusalError(refusal);
    }

    const code = randomBytes(32).toString('base64url');
    const row = await this.prisma.authHandoff.create({
      data: {
        userId,
        codeHash: hashCode(code),
        audience,
        expiresAt: new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000),
        requestedIp: meta.ip ?? null,
      },
      select: { id: true },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'AUTH_HANDOFF_CREATED',
      entityType: 'AuthHandoff',
      entityId: row.id,
      metadata: { audience, ttlSeconds: HANDOFF_TTL_SECONDS },
      ip: meta.ip ?? null,
    });
    return { code, expiresInSeconds: HANDOFF_TTL_SECONDS };
  }

  /**
   * Spend a code for a session on the console.
   *
   * ── WHY THE SPEND IS ONE CONDITIONAL UPDATE ────────────────────────────────────────
   * Reading the row, checking it and then marking it used is a race: two exchanges of one code
   * would both pass the check. `UPDATE ... WHERE consumedAt IS NULL AND revokedAt IS NULL AND
   * expiresAt > now()` lets exactly one request win, the same way refresh rotation is claimed.
   *
   * Unknown, expired, spent and revoked are answered as ONE refusal, so a holder of a stolen
   * code learns nothing about why it failed; the audit row records which it was.
   */
  async exchange(
    code: string,
    audience: HandoffAudience,
    meta: RequestMeta,
  ): Promise<AuthTokens | MfaChallengeResponse> {
    const codeHash = hashCode(code);
    const now = new Date();
    const claimed = await this.prisma.authHandoff.updateMany({
      where: { codeHash, audience, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    const row = await this.prisma.authHandoff.findUnique({
      where: { codeHash },
      select: {
        id: true,
        userId: true,
        audience: true,
        expiresAt: true,
        consumedAt: true,
        revokedAt: true,
      },
    });

    if (claimed.count !== 1 || !row) {
      const reason = !row
        ? 'unknown'
        : row.audience !== audience
          ? 'wrong_audience'
          : row.revokedAt
            ? 'revoked'
            : row.consumedAt
              ? 'reused'
              : 'expired';
      await this.audit.record({
        actorUserId: row?.userId ?? null,
        action: 'AUTH_HANDOFF_REFUSED',
        entityType: 'AuthHandoff',
        entityId: row?.id ?? null,
        metadata: { audience, stage: 'exchange', reason },
        ip: meta.ip ?? null,
      });
      throw codeNotValid();
    }

    /*
      Checked AGAIN, at exchange: up to a minute has passed since the code was minted, and a
      seat removed or an account suspended in that minute must not open the console.
    */
    const refusal = await this.refusalFor(row.userId);
    if (refusal) {
      await this.audit.record({
        actorUserId: row.userId,
        action: 'AUTH_HANDOFF_REFUSED',
        entityType: 'AuthHandoff',
        entityId: row.id,
        metadata: { audience, stage: 'exchange', reason: refusal },
        ip: meta.ip ?? null,
      });
      throw refusalError(refusal);
    }

    // The single gate every sign-in passes through: suspended accounts, and the MFA challenge.
    const result = await this.auth.completeHandoffSignIn(row.userId, meta);
    await this.audit.record({
      actorUserId: row.userId,
      action: 'AUTH_HANDOFF_EXCHANGED',
      entityType: 'AuthHandoff',
      entityId: row.id,
      metadata: { audience, mfaChallenge: 'mfaRequired' in result },
      ip: meta.ip ?? null,
    });
    return result;
  }

  /**
   * Whether this account may be carried to the organizer console right now, from the database.
   * Null means yes.
   */
  private async refusalFor(userId: string): Promise<Refusal | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user || user.status !== 'ACTIVE') return 'inactive_user';
    const seats = await this.prisma.organizationMember.findMany({
      where: { userId, status: 'ACTIVE', role: { in: ORGANIZER_SEAT_ROLES } },
      select: { organization: { select: { status: true } } },
    });
    if (seats.length === 0) return 'no_membership';
    if (seats.every((s) => s.organization.status === 'SUSPENDED')) {
      return 'organization_suspended';
    }
    return null;
  }
}

function codeNotValid(): AppException {
  return new AppException(
    ErrorCodes.INVALID_CREDENTIALS,
    'This sign-in link has expired or was already used. Open the organizer console again from your account, or sign in here.',
    HttpStatus.UNAUTHORIZED,
  );
}

function refusalError(reason: Refusal): AppException {
  switch (reason) {
    case 'inactive_user':
      return new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'This account cannot sign in.',
        HttpStatus.UNAUTHORIZED,
      );
    case 'organization_suspended':
      return new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'Your organization is suspended. Contact support for help.',
        HttpStatus.FORBIDDEN,
      );
    case 'no_membership':
      return new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'This account is not on an organizer team yet. Become an organizer first, or ask an owner to invite you.',
        HttpStatus.FORBIDDEN,
      );
  }
}
