import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as QRCode from 'qrcode';
import { createHash, createHmac, randomInt } from 'node:crypto';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { MfaSessionState } from '../../common/decorators';
import { decryptSecret, encryptSecret, parseMfaKey } from './mfa-crypto';
import { base32Encode, generateSecret, matchStep, otpauthUri } from './totp';

/** Wrong attempts (codes or recovery codes) before the account is locked for a while. */
export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MINUTES = 15;
const CHALLENGE_TTL = '5m';
const RECOVERY_CODE_COUNT = 10;
/** No 0/O/1/I: a code read off paper must not be ambiguous. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface Meta {
  ip?: string;
}

export interface MfaBinding {
  credentialId: string;
  verifiedAt: Date;
  method: 'totp' | 'recovery';
}

export const isStaff = (roles: readonly string[]): boolean =>
  roles.includes(Role.ADMIN) || roles.includes(Role.SUPER_ADMIN);

/**
 * Second factor for back-office accounts: TOTP with replay protection, recovery codes,
 * lockout, and the state the guard needs. Design and threat model: docs/security/ADMIN-MFA.md.
 *
 * Nothing in here logs or audits a code, a secret or a recovery code. Audit rows carry what
 * happened and why it failed, never the value that was typed.
 */
@Injectable()
export class MfaService implements OnModuleInit {
  private readonly logger = new Logger(MfaService.name);
  private readonly keyBytes: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
  ) {
    // Malformed keys are rejected by the config schema at boot; this re-parse keeps a service
    // constructed by hand (tests) honest too.
    this.keyBytes = parseMfaKey(this.config.get<string>('MFA_ENCRYPTION_KEY'));
  }

  /** MFA is armed only when a key is configured; unset, the feature is dormant (see docs). */
  get enabled(): boolean {
    return this.keyBytes !== null;
  }

  /**
   * MFA_ENROLLMENT: must staff enroll to use the console at all (`required`), or only before a
   * sensitive action (`deferred`)? Anything but the literal `deferred` reads as `required`, so a
   * hand-built config (tests) or a typo can only ever make this STRICTER.
   */
  get enrollment(): 'required' | 'deferred' {
    return this.config.get<string>('MFA_ENROLLMENT') === 'deferred' ? 'deferred' : 'required';
  }

  /**
   * The one case where a step-up route is still waved through with no key: a developer machine
   * (LOCAL/DEV) in `required` mode, i.e. MFA simply not armed there. The test suite and laptops
   * rely on it; every other environment, and `deferred` everywhere, refuses instead.
   */
  private get stepUpDormant(): boolean {
    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    return !this.enabled && this.enrollment === 'required' && ['LOCAL', 'DEV'].includes(appEnv);
  }

  get stepUpMs(): number {
    return Number(this.config.get('MFA_STEPUP_MINUTES') ?? 10) * 60_000;
  }

  /**
   * Refuse to boot in a real environment when authenticators exist but the key to read them
   * does not: serving then would let every enrolled administrator in with no way to prove a
   * code, or - worse - read as "MFA is off". With nothing enrolled it only warns, which is
   * what keeps the FIRST deploy of this feature from bricking the API.
   */
  async onModuleInit(): Promise<void> {
    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    const real = !['LOCAL', 'DEV'].includes(appEnv);
    if (this.enabled) {
      if (this.enrollment === 'deferred' && real) {
        this.logger.warn(
          'Admin MFA enrollment is DEFERRED (MFA_ENROLLMENT=deferred): staff without an authenticator ' +
            'sign in with a password. Sensitive admin actions (refunds, payouts, payment, fee and tax ' +
            'configuration, staff and account changes) still need an authenticator. Set ' +
            'MFA_ENROLLMENT=required to make enrollment mandatory.',
        );
      }
      await this.runBreakGlass();
      return;
    }
    const enrolled = await this.prisma.adminMfaCredential.count().catch((err: unknown) => {
      // A database without the table yet (migration not applied) is "nothing enrolled".
      if ((err as { code?: string })?.code === 'P2021') return 0;
      throw err;
    });
    if (enrolled > 0 && real) {
      throw new Error(
        `MFA_ENCRYPTION_KEY is not set but ${enrolled} administrator authenticator(s) exist in ${appEnv}. ` +
          'Refusing to start: restore the key the secrets were encrypted with.',
      );
    }
    if (real || this.enrollment === 'deferred') {
      // One line, at boot, that says what is blocked: the refusal itself is in MfaGuard.
      this.logger.warn(
        'Admin MFA is NOT configured: MFA_ENCRYPTION_KEY is not set. Staff sign in with a password, ' +
          'and every sensitive admin action (refunds, payouts, payment, fee and tax configuration, ' +
          'staff and account changes) is BLOCKED until an operator sets MFA_ENCRYPTION_KEY and staff ' +
          'set up an authenticator.',
      );
    }
    // Break-glass works with the key absent too: it only removes rows.
    await this.runBreakGlass();
  }

  private key(): Buffer {
    if (!this.keyBytes) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Multi-factor sign-in is not configured on this server.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.keyBytes;
  }

  private get issuer(): string {
    const base = this.config.get<string>('MFA_ISSUER') ?? 'ETicketsGo';
    const env = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    return env === 'PRODUCTION' ? base : `${base} ${env}`;
  }

  // ───────────────────────────── session state ─────────────────────────────

  /** Read per request by JwtStrategy: the token's claim only counts if the DB agrees. */
  async sessionState(
    userId: string,
    roles: readonly string[],
    claims: { mfaCid?: string; mfaAt?: number },
  ): Promise<MfaSessionState> {
    if (!isStaff(roles)) {
      return { required: false, enrolled: false, verified: false, verifiedAt: null };
    }
    if (!this.enabled) {
      /*
        No key: nobody can be enrolled, so nothing is required for the console as a whole. What
        a step-up route does with that is NOT "skip the check" any more - it is refused, unless
        this is a developer machine with MFA simply not armed (stepUpDormant).
      */
      return {
        required: false,
        enrolled: false,
        verified: false,
        verifiedAt: null,
        stepUp: this.stepUpDormant ? 'dormant' : 'unconfigured',
      };
    }
    const cred = await this.prisma.adminMfaCredential.findUnique({
      where: { userId },
      select: { id: true, confirmedAt: true },
    });
    const enrolled = Boolean(cred?.confirmedAt);
    const verified =
      enrolled &&
      typeof claims.mfaCid === 'string' &&
      claims.mfaCid === cred?.id &&
      typeof claims.mfaAt === 'number';
    return {
      /*
        Deferred relaxes enrollment, not the factor: an account that HAS an authenticator is
        challenged at sign-in (requiresChallenge) and held to the full rule on every route, so
        enrolling can only ever make an account stronger, never leave a hole beside the factor.
      */
      required: this.enrollment === 'required' || enrolled,
      enrolled,
      verified,
      verifiedAt: verified ? (claims.mfaAt as number) * 1000 : null,
      stepUp: 'available',
    };
  }

  /**
   * Who tried a sensitive action without the second factor it needs, and which one. Written by
   * MfaGuard before it refuses; never carries anything typed. AuditService.record never throws,
   * so a failed write cannot turn the refusal into a pass.
   */
  async recordSensitiveRefusal(
    userId: string,
    reason: 'not_enrolled' | 'not_configured',
    route: { operation: string; method: string; path: string },
    meta: Meta,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: userId,
      action: 'MFA_SENSITIVE_ACTION_REFUSED',
      entityType: 'User',
      entityId: userId,
      metadata: { reason, enrollment: this.enrollment, ...route },
      ip: meta.ip ?? null,
    });
  }

  /** At password/phone success: does this account have to prove a second factor now? */
  async requiresChallenge(userId: string, roles: readonly string[]): Promise<boolean> {
    if (!this.enabled || !isStaff(roles)) return false;
    const cred = await this.prisma.adminMfaCredential.findUnique({
      where: { userId },
      select: { confirmedAt: true },
    });
    return Boolean(cred?.confirmedAt);
  }

  // ───────────────────────────── challenge token ───────────────────────────

  /*
    Signed with a key DERIVED from the access secret, so a challenge token can never be verified
    as an access token (different key) and an access token can never be replayed as a challenge.
  */
  private challengeSecret(): string {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_ACCESS_SECRET'))
      .update('etg-mfa-challenge-v1')
      .digest('hex');
  }

  async issueChallenge(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, purpose: 'mfa-challenge' },
      { secret: this.challengeSecret(), expiresIn: CHALLENGE_TTL },
    );
  }

  async readChallenge(token: string): Promise<string> {
    try {
      const p = await this.jwt.verifyAsync<{ sub?: string; purpose?: string }>(token, {
        secret: this.challengeSecret(),
      });
      if (p.purpose !== 'mfa-challenge' || !p.sub) throw new Error('wrong purpose');
      return p.sub;
    } catch {
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'This sign-in has expired. Sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  // ───────────────────────────── verification ──────────────────────────────

  private invalid(): AppException {
    return new AppException(
      ErrorCodes.MFA_INVALID_CODE,
      'That code is not valid.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private async fail(
    cred: { id: string; userId: string },
    method: string,
    reason: string,
    meta: Meta,
  ): Promise<never> {
    const updated = await this.prisma.adminMfaCredential.update({
      where: { id: cred.id },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    await this.audit.record({
      actorUserId: cred.userId,
      action: 'MFA_VERIFY_FAILED',
      entityType: 'User',
      entityId: cred.userId,
      metadata: { method, reason },
      ip: meta.ip ?? null,
    });
    if (updated.failedAttempts >= MFA_MAX_FAILURES) {
      const until = new Date(Date.now() + MFA_LOCK_MINUTES * 60_000);
      await this.prisma.adminMfaCredential.update({
        where: { id: cred.id },
        data: { failedAttempts: 0, lockedUntil: until },
      });
      await this.audit.record({
        actorUserId: cred.userId,
        action: 'MFA_LOCKED_OUT',
        entityType: 'User',
        entityId: cred.userId,
        metadata: { minutes: MFA_LOCK_MINUTES },
        ip: meta.ip ?? null,
      });
    }
    throw this.invalid();
  }

  private assertNotLocked(cred: { lockedUntil: Date | null }): void {
    if (cred.lockedUntil && cred.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((cred.lockedUntil.getTime() - Date.now()) / 60_000));
      throw new AppException(
        ErrorCodes.MFA_LOCKED,
        `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Accept a TOTP code once. The conditional update is what makes a replay lose the race. */
  private async acceptTotp(
    cred: { id: string; userId: string; secretCiphertext: string; lastUsedStep: number },
    code: string,
  ): Promise<boolean> {
    const secret = decryptSecret(this.key(), cred.secretCiphertext, cred.userId);
    const step = matchStep(secret, code, Date.now());
    if (step === null || step <= cred.lastUsedStep) return false;
    const { count } = await this.prisma.adminMfaCredential.updateMany({
      where: { id: cred.id, lastUsedStep: { lt: step } },
      data: { lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
    });
    return count === 1;
  }

  private normaliseRecovery(input: string): string {
    return input.replace(/[\s-]/g, '').toUpperCase();
  }

  private async acceptRecovery(userId: string, input: string): Promise<boolean> {
    const given = this.normaliseRecovery(input);
    if (given.length !== 10) return false;
    const rows = await this.prisma.adminMfaRecoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });
    for (const row of rows) {
      if (await bcrypt.compare(given, row.codeHash)) {
        const { count } = await this.prisma.adminMfaRecoveryCode.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return count === 1;
      }
    }
    return false;
  }

  /**
   * Prove the second factor for an enrolled account: a TOTP code or one recovery code.
   * Used by sign-in and by step-up; returns the binding the new session must carry.
   */
  async verify(
    userId: string,
    input: { code?: string; recoveryCode?: string },
    meta: Meta,
  ): Promise<MfaBinding> {
    const cred = await this.prisma.adminMfaCredential.findUnique({ where: { userId } });
    // No authenticator: indistinguishable from a wrong code, so this cannot be used to probe who has one.
    if (!cred || !cred.confirmedAt) throw this.invalid();
    this.assertNotLocked(cred);

    if (input.recoveryCode) {
      if (!(await this.acceptRecovery(userId, input.recoveryCode))) {
        return this.fail(cred, 'recovery', 'wrong_code', meta);
      }
      await this.prisma.adminMfaCredential.update({
        where: { id: cred.id },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      const remaining = await this.prisma.adminMfaRecoveryCode.count({
        where: { userId, usedAt: null },
      });
      await this.audit.record({
        actorUserId: userId,
        action: 'MFA_RECOVERY_CODE_USED',
        entityType: 'User',
        entityId: userId,
        metadata: { remaining },
        ip: meta.ip ?? null,
      });
      return { credentialId: cred.id, verifiedAt: new Date(), method: 'recovery' };
    }

    if (!input.code || !(await this.acceptTotp(cred, input.code))) {
      return this.fail(cred, 'totp', 'wrong_or_replayed_code', meta);
    }
    return { credentialId: cred.id, verifiedAt: new Date(), method: 'totp' };
  }

  // ───────────────────────────── enrollment ────────────────────────────────

  /**
   * Begin enrollment. Needs the account PASSWORD again (not just a session): a stolen refresh
   * or access token on a not-yet-enrolled administrator must not be enough to bind an
   * attacker's authenticator to the account.
   */
  async startEnrollment(
    user: { id: string; email: string; passwordHash: string; roles: string[] },
    password: string,
    meta: Meta,
  ) {
    this.key();
    if (!isStaff(user.roles)) throw this.notStaff();
    const existing = await this.prisma.adminMfaCredential.findUnique({
      where: { userId: user.id },
      select: { confirmedAt: true },
    });
    if (existing?.confirmedAt) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'An authenticator is already set up. Ask another super admin to reset it, or use a recovery code.',
        HttpStatus.CONFLICT,
      );
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'MFA_ENROLLMENT_REFUSED',
        entityType: 'User',
        entityId: user.id,
        metadata: { reason: 'bad_password' },
        ip: meta.ip ?? null,
      });
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'Incorrect password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const secret = generateSecret();
    const ciphertext = encryptSecret(this.key(), secret, user.id);
    await this.prisma.adminMfaCredential.upsert({
      where: { userId: user.id },
      create: { userId: user.id, secretCiphertext: ciphertext },
      update: {
        secretCiphertext: ciphertext,
        lastUsedStep: 0,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      action: 'MFA_ENROLLMENT_STARTED',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip ?? null,
    });
    const uri = otpauthUri(secret, user.email, this.issuer);
    return {
      secret: base32Encode(secret),
      otpauthUri: uri,
      // Drawn here, from our own dependency: the URI never goes to a third-party QR service.
      qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220 }),
    };
  }

  private notStaff(): AppException {
    return new AppException(
      ErrorCodes.FORBIDDEN,
      'Only back-office accounts use an authenticator.',
      HttpStatus.FORBIDDEN,
    );
  }

  /** Finish enrollment with the first code. Returns the recovery codes, shown exactly once. */
  async confirmEnrollment(userId: string, code: string, meta: Meta) {
    const cred = await this.prisma.adminMfaCredential.findUnique({ where: { userId } });
    if (!cred || cred.confirmedAt) throw this.invalid();
    this.assertNotLocked(cred);
    if (!(await this.acceptTotp(cred, code))) {
      return this.fail(cred, 'totp', 'enrollment_wrong_code', meta);
    }
    await this.prisma.adminMfaCredential.update({
      where: { id: cred.id },
      data: { confirmedAt: new Date() },
    });
    const recoveryCodes = await this.replaceRecoveryCodes(userId);
    // Every session that existed before the second factor did is ended: it never proved one.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'MFA_ENROLLMENT_COMPLETED',
      entityType: 'User',
      entityId: userId,
      ip: meta.ip ?? null,
    });
    const binding: MfaBinding = {
      credentialId: cred.id,
      verifiedAt: new Date(),
      method: 'totp',
    };
    return { binding, recoveryCodes };
  }

  // ───────────────────────────── recovery codes ────────────────────────────

  private makeRecoveryCode(): string {
    let s = '';
    for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return s;
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.makeRecoveryCode());
    const hashes = await Promise.all(plain.map((c) => bcrypt.hash(c, 10)));
    await this.prisma.$transaction([
      this.prisma.adminMfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.adminMfaRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      }),
    ]);
    return plain.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
  }

  async regenerateRecoveryCodes(userId: string, meta: Meta): Promise<string[]> {
    const codes = await this.replaceRecoveryCodes(userId);
    await this.audit.record({
      actorUserId: userId,
      action: 'MFA_RECOVERY_CODES_REGENERATED',
      entityType: 'User',
      entityId: userId,
      ip: meta.ip ?? null,
    });
    return codes;
  }

  // ───────────────────────────── status / removal ──────────────────────────

  async status(userId: string) {
    const cred = await this.prisma.adminMfaCredential.findUnique({
      where: { userId },
      select: { confirmedAt: true },
    });
    const remaining = cred?.confirmedAt
      ? await this.prisma.adminMfaRecoveryCode.count({ where: { userId, usedAt: null } })
      : 0;
    return {
      enrolled: Boolean(cred?.confirmedAt),
      enrolledAt: cred?.confirmedAt?.toISOString() ?? null,
      recoveryCodesRemaining: remaining,
    };
  }

  /** Remove an account's authenticator and end its sessions; its next sign-in re-enrolls. */
  private async removeAuthenticator(userId: string): Promise<boolean> {
    const [creds] = await this.prisma.$transaction([
      this.prisma.adminMfaCredential.deleteMany({ where: { userId } }),
      this.prisma.adminMfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return creds.count > 0;
  }

  /** A holder who still has a session and a fresh check replaces their own device. */
  async replaceDevice(userId: string, meta: Meta): Promise<void> {
    await this.removeAuthenticator(userId);
    await this.audit.record({
      actorUserId: userId,
      action: 'MFA_DEVICE_REPLACED',
      entityType: 'User',
      entityId: userId,
      ip: meta.ip ?? null,
    });
  }

  /** Another super admin (with MFA, by the guard) resets someone else. Never oneself. */
  async resetForUser(
    actor: { id: string; roles: readonly string[] },
    targetUserId: string,
    meta: Meta,
  ): Promise<void> {
    if (!actor.roles.includes(Role.SUPER_ADMIN)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Only a super admin can reset another account's authenticator.",
        HttpStatus.FORBIDDEN,
      );
    }
    if (actor.id === targetUserId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot reset your own authenticator. Use a recovery code, or ask another super admin.',
        HttpStatus.FORBIDDEN,
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'No such account.', HttpStatus.NOT_FOUND);
    }
    const had = await this.removeAuthenticator(targetUserId);
    await this.audit.record({
      actorUserId: actor.id,
      action: 'MFA_RESET_BY_ADMIN',
      entityType: 'User',
      entityId: targetUserId,
      metadata: { hadAuthenticator: had },
      ip: meta.ip ?? null,
    });
  }

  // ───────────────────────────── break-glass ───────────────────────────────

  /**
   * Operator break-glass for a sole administrator who lost device AND recovery codes.
   *
   * Same trust boundary as FirstAdminBootstrap: it is a deploy-time act by whoever controls the
   * environment variables, it never opens an HTTP route, it names exactly one account, it is
   * audited with no human actor, and it closes behind itself - the nonce is stored the moment it
   * is used, so the variables staying set changes nothing on later boots.
   */
  async runBreakGlass(): Promise<void> {
    const email = (this.config.get<string>('MFA_BREAK_GLASS_EMAIL') ?? '').trim().toLowerCase();
    const nonce = (this.config.get<string>('MFA_BREAK_GLASS_NONCE') ?? '').trim();
    if (!email || !nonce) return;
    try {
      const nonceHash = createHash('sha256').update(`mfa-break-glass:${nonce}`).digest('hex');
      if (await this.prisma.adminMfaBreakGlassUse.findUnique({ where: { nonceHash } })) return;
      const user = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true, roles: true },
      });
      if (!user || !isStaff(user.roles)) {
        // Not consumed: the operator can fix the address and redeploy with the same nonce.
        this.logger.warn(
          'MFA break-glass is configured for an address that is not a back-office account; nothing was changed.',
        );
        return;
      }
      await this.prisma.adminMfaBreakGlassUse.create({ data: { nonceHash, userId: user.id } });
      const had = await this.removeAuthenticator(user.id);
      await this.audit.record({
        action: 'MFA_BREAK_GLASS',
        entityType: 'User',
        entityId: user.id,
        metadata: { hadAuthenticator: had },
      });
      this.logger.warn(
        'MFA break-glass used: the named account must enroll again at its next sign-in.',
      );
    } catch (err) {
      this.logger.warn(
        `MFA break-glass failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}
