import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthTokens, MfaChallengeResponse } from '@eticketsgo/shared-types';
import { Role, isReservedEmail, permissionsFor } from '@eticketsgo/shared-types';
import {
  getApplicablePolicy,
  policyJurisdictionFor,
  policyVersionLabel,
} from '@eticketsgo/shared-types';
import type { AdminPermission } from '@eticketsgo/shared-types';
import type { LoginInput, RegisterInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { assertAcceptablePassword } from './password-acceptance';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { MarketingConsentService } from '../notifications/marketing-consent.service';
import { normalisePhone } from './phone';
import { NotificationType } from '@eticketsgo/shared-types';
import type { AccessTokenPayload } from './jwt.strategy';
import { MfaService, type MfaBinding } from './mfa/mfa.service';
import { LoginBackoff } from './login-backoff';

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

/**
 * The bcrypt hash a sign-in compares against when there is no real one to compare against.
 *
 * ── WHY A FAILED LOOKUP STILL PAYS FOR BCRYPT ──────────────────────────────────────
 * An unknown address used to return after one SELECT, and a known one after a cost-12 bcrypt
 * comparison - about 200 ms apart, which anybody can measure from outside. That made the login
 * route a free "does this address have an account" oracle, the very question the identical error
 * message exists not to answer. So every path that has no usable hash (no account; a phone-only
 * or invited account whose hash is a placeholder; anything not shaped like bcrypt) compares the
 * typed password against this instead, at the SAME cost (12) as every hash `register` writes.
 *
 * The value is a hash of 32 random bytes nobody kept: no password matches it. It is a literal
 * rather than computed at boot so a cold start does not spend a quarter of a second on it.
 * Residual: an older account hashed at cost 10 (organizer invite acceptance) still compares
 * slightly faster than cost 12; that tells old accounts from new ones, not accounts from
 * non-accounts.
 */
export const DUMMY_PASSWORD_HASH = '$2a$12$MwPauiGYW6Il9NW1KO1L5ehTL7QA1VD.7woTc.jbZQM.Y5rAWwdvm';

/** A real bcrypt hash, as opposed to the placeholders phone-only and invited accounts carry. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * How long a password-reset request takes, whatever it finds.
 *
 * The reply was already identical for a known and an unknown address. The WORK was not: a real
 * account writes a token row in a transaction and enqueues an email, and an unknown one returned
 * after a SELECT. The same floor the guest booking lookup uses (bookings/guest-booking.service.ts,
 * LOOKUP_FLOOR_MS) closes the same quiet hole here.
 */
const RESET_REQUEST_FLOOR_MS = 250;

/**
 * How long after a refresh token was ROTATED its second presentation is treated as a race
 * rather than a theft. See `refresh`.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    /*
      LAST, and `@Optional()`, which is this codebase's rule for a new dependency: a dozen
      suites construct this service by hand and positionally, so a parameter inserted
      anywhere but the end silently shifts each of their arguments one slot along.

      Absent, a signup simply records no consent - which is the correct degradation, because
      the account and its tokens are the thing the caller asked for. The running application
      always has it; the optionality is for the harnesses.
    */
    @Optional() private readonly consent?: MarketingConsentService,
    /*
      Also last and optional. Absent (a hand-built harness) every sign-in is the plain,
      pre-MFA one; the running application always has it.
    */
    @Optional() private readonly mfa?: MfaService,
    /*
      Also last and optional. A hand-built harness gets the per-process counter (the same thing
      the running application falls back to when Redis is away), so sign-in is never left with
      no per-account limit at all.
    */
    @Optional() backoff?: LoginBackoff,
  ) {
    this.loginBackoff = backoff ?? new LoginBackoff();
  }

  private readonly loginBackoff: LoginBackoff;

  /**
   * One email address, one account.
   *
   * ── WHY THE UNIQUE INDEX WAS NOT ENOUGH ON ITS OWN ─────────────────────────────────
   * `email` is unique, but Postgres compares bytes: `Asha@Example.com` and `asha@example.com`
   * are two values to the index and one mailbox to a person. The schema lowercases what
   * arrives now, but a row written before it did would still let a second account through,
   * so the lookup ignores case rather than trusting the stored data.
   *
   * And check-then-insert is a race. Two submissions of one form — a double click, a retry on
   * a slow connection — both find nothing and both insert; the index stops the second, which
   * used to surface as a 500. It now reads as what it is.
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<AuthTokens> {
    if (isReservedEmail(input.email)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This email address cannot be used to create an account.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) throw emailAlreadyRegistered();

    // Enforced here as well as in the schema, so no caller reaches account creation with a
    // password the policy refuses.
    assertAcceptablePassword(input.password, { email: input.email, name: input.fullName });

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user
      .create({
        data: {
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          roles: [Role.CUSTOMER],
        },
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw emailAlreadyRegistered();
        throw err;
      });

    if (input.smsConsent === true && input.phone) {
      await this.recordSignupSmsConsent(user.id, user.email, input.phone, input.country);
    }
    return this.issueTokens(user.id, user.email, user.fullName, user.roles as Role[], meta);
  }

  /**
   * The text-message agreement somebody made while creating their account.
   *
   * -- WHAT IS AND IS NOT RECORDED --------------------------------------------------
   * Only an affirmative tick writes a row. A number typed without the box writes nothing,
   * because a number is a way to reach somebody and not a request to be reached - inferring
   * one from the other is the mistake the whole consent record exists to prevent.
   *
   * The scope is `sms:transactional`, never `sms`. The checkbox promises messages about
   * bookings, tickets and refunds; granting promotional SMS off the back of those words
   * would be consent for something nobody read.
   *
   * -- WHY THE NUMBER IS PASSED EXPLICITLY HERE -------------------------------------
   * Everywhere else the consent record snapshots the account's VERIFIED number, because a
   * caller-supplied number proves nothing about who agreed. At signup there is no verified
   * number yet and this one is self-declared by the person creating their own account, for
   * themselves, in the same request - so it is the right subject to record, and `source`
   * says exactly where it came from.
   * The Mobile sign-up tab passes the number its code has just PROVED instead (see
   * `applyPhoneSignup`), which is the stronger subject of the two.
   *
   * -- WHY A FAILURE HERE DOES NOT FAIL THE SIGNUP ----------------------------------
   * The account exists and tokens are about to be issued. Throwing now would leave somebody
   * registered but staring at an error, and would lose the account to recover a preference.
   * The row is evidence, not a gate; a lost one is logged and can be re-given on the
   * notification settings screen.
   */
  private async recordSignupSmsConsent(
    userId: string,
    email: string,
    rawPhone: string,
    country: string | undefined,
  ): Promise<void> {
    try {
      const phone = normalisePhone(rawPhone);
      const jurisdiction = policyJurisdictionFor(country);
      if (!this.consent) return;
      await this.consent.record({ userId, email }, 'sms:transactional', true, {
        source: 'CUSTOMER_SIGNUP',
        country: jurisdiction,
        policyVersion: policyVersionLabel(getApplicablePolicy('SMS', jurisdiction)),
        phone,
      });
    } catch (err) {
      this.logger.warn(
        `signup SMS consent not recorded for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Password sign-in.
   *
   * Three things here exist to stop the route telling a stranger anything:
   *   - every failure does the same work (one bcrypt comparison, see DUMMY_PASSWORD_HASH) and
   *     gives the same answer, account or not;
   *   - repeated failures for ONE address make that address wait (LoginBackoff), counted for
   *     addresses with no account exactly as for real ones;
   *   - a suspended or deleted account is refused only AFTER its password is proved, so the
   *     refusal is news only to somebody who already holds the password.
   */
  async login(input: LoginInput, meta: RequestMeta): Promise<AuthTokens | MfaChallengeResponse> {
    const waitMs = await this.loginBackoff.waitFor(input.email);
    if (waitMs > 0) {
      await this.audit.record({
        actorUserId: null,
        action: 'AUTH_LOGIN_BACKOFF',
        entityType: 'User',
        entityId: null,
        metadata: { email: input.email, waitSeconds: Math.ceil(waitMs / 1000) },
        ip: meta.ip ?? null,
      });
      throw tooManySignInAttempts(waitMs);
    }

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const usableHash = user && BCRYPT_HASH.test(user.passwordHash) ? user.passwordHash : null;
    // Always exactly one comparison, so an unknown address costs what a wrong password costs.
    const matches = await bcrypt.compare(input.password, usableHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !usableHash || !matches) {
      const startedWaitMs = await this.loginBackoff.recordFailure(input.email);
      // Forensic trail for credential-stuffing / brute-force (audit is fail-safe).
      await this.audit.record({
        actorUserId: user?.id ?? null,
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: {
          email: input.email,
          reason: !user ? 'unknown_user' : !usableHash ? 'no_password' : 'bad_password',
          ...(startedWaitMs > 0 ? { backoffSeconds: Math.ceil(startedWaitMs / 1000) } : {}),
        },
        ip: meta.ip ?? null,
      });
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'Incorrect email or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // The password is right, so the count for this address starts again.
    await this.loginBackoff.reset(input.email);
    await this.audit.record({
      actorUserId: user.id,
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip ?? null,
    });
    return this.signInOrChallenge(user, meta);
  }

  /**
   * The single gate every credential-based sign-in passes through (password, phone code).
   *
   * An enrolled back-office account is NOT given tokens here: it is given a short-lived,
   * purpose-bound challenge that `POST /auth/mfa/verify` exchanges for tokens once a code is
   * proved. An administrator who has not enrolled yet gets tokens with no MFA claim, which every
   * route but the enrollment ones refuses (MfaGuard) - that is how the existing administrator is
   * walked into enrolling without ever being locked out. Everyone else is unaffected.
   */
  private async signInOrChallenge(
    user: { id: string; email: string; fullName: string; roles: unknown; status: string },
    meta: RequestMeta,
  ): Promise<AuthTokens | MfaChallengeResponse> {
    /*
      A suspended or deleted account gets nothing here: no tokens and no MFA challenge. Every
      request with an existing access token is already refused for such an account (JwtStrategy),
      but sign-in itself handed out fresh tokens, so a suspension did not stop somebody signing
      straight back in. Same words as the second-factor route uses for the same case.
    */
    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        actorUserId: user.id,
        action: 'AUTH_LOGIN_REFUSED_INACTIVE',
        entityType: 'User',
        entityId: user.id,
        metadata: { status: user.status },
        ip: meta.ip ?? null,
      });
      throw accountCannotSignIn();
    }
    const roles = user.roles as Role[];
    if (this.mfa && (await this.mfa.requiresChallenge(user.id, roles))) {
      return {
        mfaRequired: true,
        challengeToken: await this.mfa.issueChallenge(user.id),
        methods: ['totp', 'recovery'],
      };
    }
    return this.issueTokens(user.id, user.email, user.fullName, roles, meta);
  }

  /** Tokens for a session that has just passed the second factor. */
  async issueMfaSession(userId: string, meta: RequestMeta, binding: MfaBinding) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw accountCannotSignIn();
    return this.issueTokens(
      user.id,
      user.email,
      user.fullName,
      user.roles as Role[],
      meta,
      binding,
    );
  }

  /**
   * A fresh access token for the SAME session after a step-up check. No new refresh token: the
   * refresh binding keeps the session's original verification time, so the extra freshness
   * lives only as long as this access token and cannot be carried into a rotation.
   */
  async issueStepUpAccessToken(userId: string, binding: MfaBinding): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.signAccess(user.id, user.email, user.fullName, user.roles as Role[], binding);
  }

  /**
   * Trade a refresh token for a new pair, spending the old one.
   *
   * ── WHY THE SPEND IS ONE CONDITIONAL UPDATE ────────────────────────────────────────
   * This used to read the row, check `revokedAt`, mint a new pair and then mark the old row
   * revoked unconditionally. Two requests carrying the same token could both pass the check
   * before either wrote, and both walked away with a live session: one stolen token became two
   * sessions, and reuse detection never fired. Now the new pair's row is written first and the
   * old row is claimed with `UPDATE ... WHERE revokedAt IS NULL`, which the database lets exactly
   * one request win. The loser's freshly written row is revoked again before it is ever returned.
   *
   * The claim also stamps `replacedByTokenId` in the same write, so "revoked by rotation" (has a
   * replacement) and "revoked by sign-out" (none) can always be told apart - including by a
   * request that loses the race a millisecond later.
   *
   * ── WHY A RECENT ROTATION DOES NOT BURN THE FAMILY ─────────────────────────────────
   * A token presented again after it was spent is normally a replay, and the response is to
   * revoke every session the account has. But the commonest second presentation is innocent:
   * two tabs, or an app and its background task, both noticing the access token has expired and
   * refreshing with the token they share. Burning the family then signs a customer out
   * everywhere for having two tabs open. So a token that was ROTATED within the last
   * REFRESH_REUSE_GRACE_MS (10 s) is simply refused for that request - the other request already
   * holds the new session - and nothing else is revoked. Outside the window, or for a token that
   * was signed out rather than rotated, it is treated as theft exactly as before.
   *
   * The cost, accepted: somebody who has stolen a refresh token and presents it within ten
   * seconds of its owner is refused without the family being burned. They still get nothing, and
   * any later presentation burns it.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { mfa: true },
    });
    if (!record || record.expiresAt < new Date()) throw sessionExpired();
    if (record.revokedAt) {
      await this.refuseSpentToken(record.id, record.userId, meta);
    }
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    // A suspended or deleted account cannot renew a session either, only end it.
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Session invalid.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const tokens = await this.issueTokens(
      user.id,
      user.email,
      user.fullName,
      user.roles as Role[],
      meta,
      /*
        The rotation inherits EXACTLY what the old session proved - no binding in, no binding
        out, and the original verification time rather than now. A refresh can therefore never
        mint a second-factor claim the session did not earn.
      */
      record.mfa
        ? {
            credentialId: record.mfa.credentialId,
            verifiedAt: record.mfa.verifiedAt,
            method: record.mfa.method as MfaBinding['method'],
          }
        : undefined,
    );
    const replacement = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(tokens.refreshToken) },
      select: { id: true },
    });
    // The claim. Exactly one request carrying this token gets count = 1.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedByTokenId: replacement?.id ?? null },
    });
    if (claimed.count !== 1) {
      // Lost the race: the pair just minted must never work.
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashToken(tokens.refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.refuseSpentToken(record.id, record.userId, meta);
    }
    return tokens;
  }

  /**
   * A token that is already spent: refuse it, and decide whether that is a race or a theft.
   * Always throws.
   */
  private async refuseSpentToken(
    recordId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<never> {
    // Re-read: in a race the winner's write is what decides, not what this request saw earlier.
    const spent = await this.prisma.refreshToken.findUnique({
      where: { id: recordId },
      select: { revokedAt: true, replacedByTokenId: true },
    });
    const rotatedRecently = Boolean(
      spent?.revokedAt &&
      spent.replacedByTokenId &&
      Date.now() - spent.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS,
    );
    if (rotatedRecently) {
      await this.audit.record({
        actorUserId: userId,
        action: 'AUTH_REFRESH_SUPERSEDED',
        entityType: 'RefreshToken',
        entityId: recordId,
        metadata: { familyRevoked: false, graceMs: REFRESH_REUSE_GRACE_MS },
        ip: meta.ip ?? null,
      });
      throw sessionExpired();
    }
    // Reuse detection: a recognized-but-already-revoked token is a token that was
    // already rotated (or explicitly logged out). Presenting it again is a replay
    // and a compromise signal — the same secret is now in two places. Treat the
    // whole family as burned: revoke every still-active refresh token for the user
    // (forcing a fresh sign-in everywhere), then reject.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'AUTH_TOKEN_REUSE_DETECTED',
      entityType: 'RefreshToken',
      entityId: recordId,
      metadata: { familyRevoked: true },
      ip: meta.ip ?? null,
    });
    throw sessionExpired();
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  /**
   * "Sign out everywhere": revoke every refresh token the account holds.
   *
   * No device can renew a session afterwards. Access tokens already issued are stateless and
   * run out on their own within JWT_ACCESS_TTL (15 minutes by default); a password reset does
   * the same revocation as part of its own transaction.
   */
  async logoutAll(userId: string, meta: RequestMeta): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'AUTH_LOGOUT_ALL',
      entityType: 'User',
      entityId: userId,
      metadata: { revoked: count },
      ip: meta.ip ?? null,
    });
    return count;
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
  /**
   * What the Mobile sign-up tab adds to a proven number: a name, and the text-message agreement.
   *
   * ── WHY ONLY AN EMPTY NAME IS FILLED ───────────────────────────────────────────────
   * The sign-up tab cannot know whether the number already has an account - saying so would make
   * request-code an "is this person registered" oracle. So a number that does have one simply
   * signs in, and its name is left alone: a sign-up form must never be a way to rename somebody
   * else's account, or your own by accident. A phone-only account created by an earlier sign-in
   * has an empty name, and that one is filled.
   *
   * ── WHY THE CONSENT IS RECORDED HERE AND NOT THROUGH THE SETTINGS ENDPOINT ──────────
   * Provenance. The settings endpoint records `account-settings:*`, which would claim the person
   * ticked a box on the settings screen. They ticked it on the sign-up form, and the evidence
   * says so (`CUSTOMER_SIGNUP`), against the number the code just PROVED - a stronger subject
   * than the self-declared number the email form records.
   *
   * Neither step fails the sign-in: the code is already spent and the person is owed a session.
   */
  async applyPhoneSignup(
    userId: string,
    input: { fullName?: string; smsConsent?: true; country?: string },
  ): Promise<void> {
    if (!input.fullName && input.smsConsent !== true) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, phone: true },
    });
    if (!user) return;
    if (input.fullName && !user.fullName.trim()) {
      await this.prisma.user
        .updateMany({ where: { id: user.id, fullName: '' }, data: { fullName: input.fullName } })
        .catch((err: unknown) =>
          this.logger.warn(`sign-up name not saved for user ${user.id}: ${(err as Error).message}`),
        );
    }
    if (input.smsConsent === true && user.phone) {
      await this.recordSignupSmsConsent(user.id, user.email, user.phone, input.country);
    }
  }

  async completePhoneSignIn(
    userId: string,
    meta: RequestMeta,
  ): Promise<AuthTokens | MfaChallengeResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'That code is not valid. Ask for a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // The same gate as the password route: a phone code must not be a way round the second factor.
    return this.signInOrChallenge(user, meta);
  }

  private async signAccess(
    userId: string,
    email: string,
    fullName: string,
    roles: Role[],
    mfa?: MfaBinding,
  ): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: userId,
      email,
      name: fullName,
      roles,
      ...(mfa
        ? {
            amr: ['pwd', mfa.method === 'recovery' ? 'rcv' : 'otp'],
            mfaCid: mfa.credentialId,
            mfaAt: Math.floor(mfa.verifiedAt.getTime() / 1000),
          }
        : {}),
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // @nestjs/jwt v11 types expiresIn as ms' `StringValue` template-literal union; a config
      // string ('900s' default) is valid at runtime but not provably assignable, so cast to the
      // exact option type. Behaviour and the TTL source are unchanged.
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '900s') as JwtSignOptions['expiresIn'],
    });
  }

  private async issueTokens(
    userId: string,
    email: string,
    fullName: string,
    roles: Role[],
    meta: RequestMeta,
    mfa?: MfaBinding,
  ): Promise<AuthTokens> {
    const accessToken = await this.signAccess(userId, email, fullName, roles, mfa);

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
        ...(mfa
          ? {
              mfa: {
                create: {
                  credentialId: mfa.credentialId,
                  verifiedAt: mfa.verifiedAt,
                  method: mfa.method,
                },
              },
            }
          : {}),
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
    const startedAt = Date.now();
    try {
      await this.startPasswordReset(email, meta);
    } finally {
      // Known or unknown, the caller waits out the same budget (RESET_REQUEST_FLOOR_MS).
      const remaining = RESET_REQUEST_FLOOR_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private async startPasswordReset(email: string, meta: RequestMeta): Promise<void> {
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
      include: { user: { select: { id: true, email: true, status: true, fullName: true } } },
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

    /*
      Checked after the link is proven good and before it is spent, so a refused password
      leaves the link usable: the person tries a better one instead of requesting a new email.
    */
    assertAcceptablePassword(newPassword, { email: row.user.email, name: row.user.fullName });

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

    /*
      Proving control of the mailbox is a stronger proof than a password, so it also ends any
      sign-in wait for this address. This is the owner's way out when somebody else has been
      making their account wait by guessing at it.
    */
    await this.loginBackoff.reset(row.user.email);

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

  /**
   * The state this customer last told us they were in, if any.
   *
   * Read from their most recent booking that recorded one, so a returning buyer is not asked
   * a question they have already answered. Null for a first purchase, which is the only time
   * the field genuinely needs filling in.
   */
  async lastBuyerRegion(userId: string): Promise<string | null> {
    const last = await this.prisma.booking.findFirst({
      where: { userId, customerRegion: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { customerRegion: true },
    });
    return last?.customerRegion ?? null;
  }

  /**
   * The facts about an account that the profile screen shows and the token does not carry.
   *
   * ── WHY NOT PUT THEM IN THE TOKEN ──────────────────────────────────────────────────
   * A JWT is a claim about identity, cached for as long as it lives. A phone number that was
   * just added, or a verification that just happened, would not appear until the token was
   * refreshed - so the screen would say "no phone number" straight after somebody added one.
   * These are read at request time precisely because they change.
   */
  /**
   * What this account may do in the back office, from its own point of view.
   *
   * ── WHY THE CLIENT IS TOLD AT ALL ──────────────────────────────────────────────────
   * The capability model is enforced entirely on the server, and the console knew nothing
   * about it. So the console showed every operator the same twenty-four navigation items and
   * the same landing page, and found out what they were allowed to do by being refused.
   *
   * That is not a cosmetic problem. `GET /admin/dashboard` requires `BOOKING_READ`, which the
   * moderation duty does not grant, so somebody whose whole job is reviewing organizers and
   * events signed in and the first thing they saw was "We couldn't load this. Please try
   * again." - a dead end with a button that cannot work, on the page they land on.
   *
   * ── IT IS NOT AUTHORIZATION ────────────────────────────────────────────────────────
   * This answers "what should I offer this person", never "may this person do this". Every
   * route keeps its own guard and that guard keeps reading the grants from the database on
   * each request, so a capability revoked mid-session still takes effect immediately. A client
   * holding a stale list can only ask; it cannot authorise itself.
   *
   * Disclosing it is safe because it is the caller's OWN authorization, which they could map
   * by trial in a minute, and nobody else's.
   *
   * Computed with the same `permissionsFor()` the guard uses, so there is one answer to the
   * question rather than two that can drift. Empty for everybody who is not platform staff.
   */
  async myAdminPermissions(
    userId: string,
    roles: readonly Role[],
  ): Promise<{ adminPermissions: AdminPermission[] }> {
    const staff = roles.includes(Role.ADMIN) || roles.includes(Role.SUPER_ADMIN);
    if (!staff) return { adminPermissions: [] };
    const rows = await this.prisma.adminGrant.findMany({
      where: { userId },
      select: { permission: true },
    });
    const held = permissionsFor(
      roles,
      rows.map((r) => r.permission as AdminPermission),
    );
    // Sorted so the same grants always serialise identically, which keeps a client's cache
    // from being invalidated by nothing more than row order.
    return { adminPermissions: [...held].sort() };
  }

  async accountDetails(userId: string): Promise<{
    phone: string | null;
    phoneVerified: boolean;
    memberSince: string;
    locale: string | null;
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true, createdAt: true, locale: true },
    });
    return {
      phone: row?.phone ?? null,
      // An unverified number is never stored, so this is belt and braces - but the screen
      // states it, and a screen that states something must read it rather than assume it.
      phoneVerified: Boolean(row?.phoneVerifiedAt),
      memberSince: (row?.createdAt ?? new Date()).toISOString(),
      locale: row?.locale ?? null,
    };
  }
}

function parseTtlDays(ttl: string): number {
  const match = /^(\d+)\s*d$/.exec(ttl.trim());
  return match ? Number(match[1]) : 30;
}

function sessionExpired(): AppException {
  return new AppException(
    ErrorCodes.INVALID_REFRESH_TOKEN,
    'Your session has expired. Please sign in again.',
    HttpStatus.UNAUTHORIZED,
  );
}

function accountCannotSignIn(): AppException {
  return new AppException(
    ErrorCodes.INVALID_CREDENTIALS,
    'This account cannot sign in.',
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * The answer while an address is waiting. It says nothing about whether the address has an
 * account - addresses with none wait exactly the same way - and it tells the person what to do.
 */
function tooManySignInAttempts(waitMs: number): AppException {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return new AppException(
    ErrorCodes.RATE_LIMITED,
    `Too many wrong passwords for this email. Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again, or reset your password.`,
    HttpStatus.TOO_MANY_REQUESTS,
    { retryAfterSeconds: Math.ceil(waitMs / 1000) },
  );
}

function emailAlreadyRegistered(): AppException {
  return new AppException(
    ErrorCodes.EMAIL_ALREADY_REGISTERED,
    'An account with this email already exists.',
    HttpStatus.CONFLICT,
  );
}

/** Prisma's unique-constraint violation, recognised structurally as elsewhere in this API. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
