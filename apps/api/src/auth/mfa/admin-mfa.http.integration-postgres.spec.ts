import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import {
  ADMIN_PERMISSION_KEY,
  IS_PUBLIC_KEY,
  MFA_PENDING_KEY,
  ROLES_KEY,
} from '../../common/decorators';
import { base32Decode, hotp, stepFor } from './totp';

/**
 * integration-real-postgres, whole app over HTTP: admin MFA, end to end.
 *
 * The properties that matter, each asserted through the real guards, strategy and database:
 *   - the existing administrator is walked into enrollment and never locked out;
 *   - an unverified back-office session is refused on EVERY authenticated route (enumerated by
 *     reflecting on the running Nest app, not by a list someone has to keep up);
 *   - a refresh can never mint a second-factor claim the session did not have;
 *   - codes are single use, locked out after repeated failure, and recovery/reset/break-glass work.
 *
 * Skips (never fabricates a pass) without a database.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../../.env', '../../../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const PASSWORD = 'Vermilion-Lantern-4821!';
const MFA_KEY = randomBytes(32).toString('base64');
const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-for-admin-mfa-spec';

describe('integration-real-postgres: admin MFA over HTTP', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `mfa-${Date.now()}`;
  const emails = {
    sole: `sole-${suffix}@test.invalid`,
    second: `second-${suffix}@test.invalid`,
    plain: `plain-${suffix}@test.invalid`,
    customer: `cust-${suffix}@test.invalid`,
    organizer: `org-${suffix}@test.invalid`,
    lost: `lost-${suffix}@test.invalid`,
  };
  const ids: Record<string, string> = {};
  /** Every code / recovery code typed during the run: none may appear in an audit row. */
  const typed: string[] = [];
  let plainEnroll: Awaited<ReturnType<typeof enroll>>;
  let secondEnroll: Awaited<ReturnType<typeof enroll>>;

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: (json?.data ?? json) as any };
  }

  async function boot(withKey: boolean) {
    if (app) await app.close();
    app = undefined;
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = 'LOCAL';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.AUTH_THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET = JWT_SECRET;
    // Required by the config schema; CI provides them, a laptop run may not.
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-admin-mfa-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-admin-mfa-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-admin-mfa-spec-0123456789';
    if (withKey) process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
    else delete process.env.MFA_ENCRYPTION_KEY;
    // First loaded here, after the environment is set: the throttle ceilings are read at import time.
    const { AppModule } = await import('../../app.module');
    const { AllExceptionsFilter } = await import('../../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }

  const login = (email: string) =>
    http('POST', '/auth/login', undefined, { email, password: PASSWORD });

  /** Code for "now" (or a neighbouring step); unlocks the replay counter first if asked. */
  async function code(userId: string, secret: Buffer, offsetSteps = 0, reset = false) {
    if (reset)
      await db!.adminMfaCredential.updateMany({ where: { userId }, data: { lastUsedStep: 0 } });
    const c = hotp(secret, stepFor(Date.now()) + offsetSteps);
    typed.push(c);
    return c;
  }

  /** Sign in (unenrolled) -> enroll -> confirm. Returns everything a later step needs. */
  async function enroll(email: string) {
    const pending = (await login(email)).json;
    expect(pending.accessToken).toBeDefined();
    const start = await http('POST', '/auth/mfa/enroll/start', pending.accessToken, {
      password: PASSWORD,
    });
    expect(start.status).toBeLessThan(300);
    const secret = base32Decode(start.json.secret);
    const confirm = await http('POST', '/auth/mfa/enroll/confirm', pending.accessToken, {
      code: await code(ids[email], secret),
    });
    expect(confirm.status).toBeLessThan(300);
    typed.push(...confirm.json.recoveryCodes);
    return {
      secret,
      start: start.json,
      tokens: {
        accessToken: confirm.json.accessToken as string,
        refreshToken: confirm.json.refreshToken as string,
      },
      recoveryCodes: confirm.json.recoveryCodes as string[],
    };
  }

  /** Sign in as an enrolled account using a recovery code (keeps the TOTP step free). */
  async function signInWithRecovery(email: string, recovery: string) {
    const l = await login(email);
    expect(l.json.mfaRequired).toBe(true);
    const v = await http('POST', '/auth/mfa/verify', undefined, {
      challengeToken: l.json.challengeToken,
      recoveryCode: recovery,
    });
    typed.push(recovery);
    return v;
  }

  const mintOldToken = (userId: string, email: string, roles: string[]) =>
    new JwtService({}).signAsync(
      { sub: userId, email, name: 'Old Token', roles },
      { secret: JWT_SECRET, expiresIn: '15m' },
    );

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mk = async (key: keyof typeof emails, roles: string[]) => {
      const u = await db!.user.create({
        data: { email: emails[key], fullName: `MFA ${key}`, passwordHash: hash, roles },
      });
      ids[emails[key]] = u.id;
      ids[key] = u.id;
    };
    await mk('sole', ['CUSTOMER', 'SUPER_ADMIN']);
    await mk('second', ['CUSTOMER', 'SUPER_ADMIN']);
    await mk('plain', ['CUSTOMER', 'ADMIN']);
    await mk('customer', ['CUSTOMER']);
    await mk('organizer', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await mk('lost', ['CUSTOMER', 'SUPER_ADMIN']);
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const uids = users.map((u: { id: string }) => u.id);
      await db.auditLog.deleteMany({ where: { actorUserId: { in: uids } } });
      await db.auditLog.deleteMany({ where: { entityId: { in: uids } } });
      await db.adminMfaBreakGlassUse.deleteMany({ where: { userId: { in: uids } } });
      // Credentials, recovery codes, refresh tokens and their bindings cascade with the user.
      await db.user.deleteMany({ where: { id: { in: uids } } });
      await db.$disconnect();
    }
    if (app) await app.close();
    delete process.env.MFA_ENCRYPTION_KEY;
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 90_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  // ───────────────────────── 1. migration / no lockout ─────────────────────────

  describe('the existing administrator is migrated without a lockout', () => {
    let preDeployAccess = '';
    let preDeployRefresh = '';

    maybe(
      'BEFORE the key is set: sign-in and admin routes behave exactly as they did',
      async () => {
        await boot(false);
        const l = await login(emails.sole);
        expect(l.json.mfaRequired).toBeUndefined();
        expect(l.json.accessToken).toBeDefined();
        preDeployAccess = l.json.accessToken;
        preDeployRefresh = l.json.refreshToken;
        expect((await http('GET', '/admin/staff', l.json.accessToken)).status).toBe(200);
        const me = await http('GET', '/auth/me', l.json.accessToken);
        // 'dormant': LOCAL with no key and MFA_ENROLLMENT=required, the one case where a step-up
        // route is still not checked (anywhere else it is refused; see MfaService.sessionState).
        expect(me.json.mfa).toEqual({
          required: false,
          enrolled: false,
          verified: false,
          verifiedAt: null,
          stepUp: 'dormant',
        });
      },
    );

    maybe(
      'AFTER the key is set: the old token is refused on admin routes, the old refresh token still works but only to enroll',
      async () => {
        await boot(true);
        const old = await http('GET', '/admin/staff', preDeployAccess);
        expect(old.status).toBe(403);
        expect(old.json.code).toBe('MFA_REQUIRED');

        const rot = await http('POST', '/auth/refresh', undefined, {
          refreshToken: preDeployRefresh,
        });
        expect(rot.status).toBeLessThan(300);
        expect((await http('GET', '/admin/staff', rot.json.accessToken)).json.code).toBe(
          'MFA_REQUIRED',
        );
        preDeployRefresh = rot.json.refreshToken; // the rotated one is the live pre-MFA session now
        const me = await http('GET', '/auth/me', rot.json.accessToken);
        expect(me.status).toBe(200);
        expect(me.json.mfa).toMatchObject({ required: true, enrolled: false, verified: false });
        // What the account may do is not disclosed to a session that has not proved the factor.
        expect(me.json.adminPermissions).toEqual([]);
      },
    );

    maybe(
      'the sole administrator signs in, enrolls, and is back in the console: no lockout',
      async () => {
        const l = await login(emails.sole);
        expect(l.json.accessToken).toBeDefined(); // not a challenge: not enrolled yet
        const pending = l.json.accessToken as string;

        // Enrollment needs the password again: a bare stolen session cannot bind a device.
        const noPw = await http('POST', '/auth/mfa/enroll/start', pending, {
          password: 'wrong-password-123',
        });
        expect(noPw.status).toBe(401);

        const e = await enroll(emails.sole);
        expect(e.recoveryCodes).toHaveLength(10);
        const staff = await http('GET', '/admin/staff', e.tokens.accessToken);
        expect(staff.status).toBe(200);
        // The session that proved the factor keeps working across a refresh...
        const rot = await http('POST', '/auth/refresh', undefined, {
          refreshToken: e.tokens.refreshToken,
        });
        expect((await http('GET', '/admin/staff', rot.json.accessToken)).status).toBe(200);
        // ...and the pre-MFA sessions were ended by enrollment. (Last: presenting a revoked
        // refresh token burns the family by design, which would take the session above with it.)
        expect(
          (await http('POST', '/auth/refresh', undefined, { refreshToken: preDeployRefresh }))
            .status,
        ).toBe(401);
      },
    );
  });

  // ───────────────────────── 2. enforcement: no bypass ─────────────────────────

  describe('no bypass: every authenticated route refuses a back-office session without the claim', () => {
    /** Every route of the running application, with what Nest would resolve for it. */
    function routes() {
      const container = app!.get(ModulesContainer);
      const out: Array<{
        method: string;
        path: string;
        isPublic: boolean;
        pendingOk: boolean;
        adminDeclared: boolean;
        name: string;
      }> = [];
      const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
      for (const mod of container.values()) {
        for (const wrapper of mod.controllers.values()) {
          const ctrl = wrapper.metatype as (new (...a: never[]) => unknown) | null;
          if (!ctrl) continue;
          const cp = Reflect.getMetadata(PATH_METADATA, ctrl);
          if (cp === undefined) continue;
          const proto = ctrl.prototype as Record<string, unknown>;
          for (const key of Object.getOwnPropertyNames(proto)) {
            const handler = proto[key];
            if (typeof handler !== 'function' || key === 'constructor') continue;
            const m = Reflect.getMetadata(METHOD_METADATA, handler);
            if (m === undefined) continue;
            const hp = Reflect.getMetadata(PATH_METADATA, handler);
            const join = (...parts: unknown[]) =>
              '/' +
              parts
                .flatMap((p) => (Array.isArray(p) ? p[0] : p))
                .map((p) => String(p ?? '').replace(/^\/+|\/+$/g, ''))
                .filter(Boolean)
                .join('/');
            const path = join(cp, hp)
              .replace(/:[A-Za-z0-9_]+/g, 'x')
              .replace(/\*[A-Za-z0-9_]*/g, 'x');
            const get = (k: string) =>
              Reflect.getMetadata(k, handler) ?? Reflect.getMetadata(k, ctrl);
            const roles = (get(ROLES_KEY) as string[] | undefined) ?? [];
            const caps = (get(ADMIN_PERMISSION_KEY) as string[] | undefined) ?? [];
            out.push({
              method: METHODS[m] ?? 'GET',
              path,
              isPublic: Boolean(get(IS_PUBLIC_KEY)),
              pendingOk: Boolean(get(MFA_PENDING_KEY)),
              adminDeclared:
                roles.includes('ADMIN') || roles.includes('SUPER_ADMIN') || caps.length > 0,
              name: `${ctrl.name}.${key}`,
            });
          }
        }
      }
      return out.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS' && r.method !== 'HEAD');
    }

    maybe(
      'enumerates the whole route table and refuses a claimless admin session on all of it',
      async () => {
        const all = routes();
        const authed = all.filter((r) => !r.isPublic);
        // A route cannot dodge the guard by also being @Public: none may be both.
        expect(all.filter((r) => r.isPublic && r.adminDeclared).map((r) => r.name)).toEqual([]);
        const adminDeclared = authed.filter((r) => r.adminDeclared);
        // A parser that found nothing would make every assertion below vacuous.
        expect(authed.length).toBeGreaterThan(200);
        expect(adminDeclared.length).toBeGreaterThan(80);

        // Three kinds of claimless back-office session, none of which may reach anything.
        const second = emails.second;
        const pending = (await login(second)).json.accessToken as string; // signed in, not enrolled
        const oldStyle = await mintOldToken(ids.second, second, ['CUSTOMER', 'SUPER_ADMIN']); // pre-deploy token
        plainEnroll = await enroll(emails.plain); // enrolled admin...
        const staleSession = await mintOldToken(ids.plain, emails.plain, ['CUSTOMER', 'ADMIN']); // ...old token, no claim

        const leaks: string[] = [];
        let checked = 0;
        for (const token of [pending, oldStyle, staleSession]) {
          for (const r of authed) {
            if (r.pendingOk) continue; // the declared enrollment/status routes, asserted separately
            const res = await http(r.method, r.path, token, r.method === 'GET' ? undefined : {});
            checked++;
            if (res.status !== 403 || res.json?.code !== 'MFA_REQUIRED') {
              leaks.push(
                `${r.method} ${r.path} (${r.name}) -> ${res.status} ${res.json?.code ?? ''}`,
              );
            }
          }
        }
        expect(leaks).toEqual([]);
        expect(checked).toBeGreaterThan(600);
      },
      280_000,
    );

    maybe(
      'the only routes an unverified session may call are the declared enrollment ones',
      async () => {
        const pendingOk = routes()
          .filter((r) => r.pendingOk)
          .map((r) => `${r.method} ${r.path}`)
          .sort();
        expect(pendingOk).toEqual(
          [
            'GET /auth/me',
            'GET /auth/mfa/status',
            'POST /auth/mfa/enroll/confirm',
            'POST /auth/mfa/enroll/start',
          ].sort(),
        );
      },
    );

    maybe(
      'a verified session passes the same guard (the sweep is not refusing everything)',
      async () => {
        const e = await enroll(emails.lost);
        const gets = routes().filter((r) => !r.isPublic && r.method === 'GET' && r.adminDeclared);
        let reached = 0;
        for (const r of gets.slice(0, 60)) {
          const res = await http('GET', r.path, e.tokens.accessToken);
          expect(res.json?.code).not.toBe('MFA_REQUIRED');
          if (res.status === 200) reached++;
        }
        expect(reached).toBeGreaterThan(5);
      },
      120_000,
    );

    maybe(
      'customers and organizers are unaffected: no MFA requirement, no MFA error anywhere',
      async () => {
        const cust = (await login(emails.customer)).json;
        const org = (await login(emails.organizer)).json;
        expect(cust.mfaRequired).toBeUndefined();
        expect(org.mfaRequired).toBeUndefined();
        for (const t of [cust.accessToken, org.accessToken]) {
          const me = await http('GET', '/auth/me', t);
          expect(me.status).toBe(200);
          expect(me.json.mfa).toEqual({
            required: false,
            enrolled: false,
            verified: false,
            verifiedAt: null,
          });
        }
        // Sweep every GET they can address: none may answer with an MFA error.
        const gets = routes().filter((r) => !r.isPublic && r.method === 'GET');
        for (const t of [cust.accessToken, org.accessToken]) {
          for (const r of gets) {
            const res = await http('GET', r.path, t);
            expect(['MFA_REQUIRED', 'MFA_STEP_UP_REQUIRED']).not.toContain(res.json?.code);
          }
        }
        // Customers cannot enroll an authenticator.
        const start = await http('POST', '/auth/mfa/enroll/start', cust.accessToken, {
          password: PASSWORD,
        });
        expect(start.status).toBe(403);
      },
      200_000,
    );
  });

  // ───────────────────────── 3. sign-in, replay, window, lockout ───────────────

  describe('sign-in with an authenticator', () => {
    maybe(
      'password alone yields a challenge, not tokens; a code completes it; the same code cannot be replayed',
      async () => {
        // `sole` enrolled above; its confirm used the current step, so the NEXT step is the fresh one.
        const row = await db!.adminMfaCredential.findUniqueOrThrow({ where: { userId: ids.sole } });
        expect(row.confirmedAt).not.toBeNull();
        const l = await login(emails.sole);
        expect(l.json.mfaRequired).toBe(true);
        expect(l.json.accessToken).toBeUndefined();
        expect(l.json.refreshToken).toBeUndefined();

        // Reconstruct the secret from the DB the way the service does, to prove what is stored.
        const { decryptSecret } = await import('./mfa-crypto');
        const secret = decryptSecret(
          Buffer.from(MFA_KEY, 'base64'),
          row.secretCiphertext,
          ids.sole,
        );
        expect(row.secretCiphertext).not.toContain(secret.toString('base64url'));

        const c = await code(ids.sole, secret, 1); // next step: within the +-1 window, newer than the last
        const ok = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: l.json.challengeToken,
          code: c,
        });
        expect(ok.status).toBeLessThan(300);
        expect((await http('GET', '/admin/staff', ok.json.accessToken)).status).toBe(200);

        const replay = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: l.json.challengeToken,
          code: c,
        });
        expect(replay.status).toBe(401);
        expect(replay.json.code).toBe('MFA_INVALID_CODE');

        // Two steps ahead is outside the window.
        const far = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: l.json.challengeToken,
          code: await code(ids.sole, secret, 2),
        });
        expect(far.status).toBe(401);
        await db!.adminMfaCredential.updateMany({
          where: { userId: ids.sole },
          data: { failedAttempts: 0 },
        });
      },
    );

    maybe(
      'a challenge is not an access token, and an access token is not a challenge',
      async () => {
        const l = await login(emails.sole);
        expect((await http('GET', '/auth/me', l.json.challengeToken)).status).toBe(401);
        const old = await mintOldToken(ids.sole, emails.sole, ['SUPER_ADMIN']);
        const v = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: old,
          recoveryCode: 'AAAAA-AAAAA',
        });
        expect(v.status).toBe(401);
        expect(v.json.code).toBe('INVALID_CREDENTIALS');
      },
    );

    maybe(
      'an admin signing in by phone code gets the same challenge, not a way round it',
      async () => {
        const { AuthService } = await import('../auth.service');
        const auth = app!.get(AuthService);
        const r = (await auth.completePhoneSignIn(ids.sole, {})) as {
          mfaRequired?: boolean;
          accessToken?: string;
        };
        expect(r.mfaRequired).toBe(true);
        expect(r.accessToken).toBeUndefined();
      },
    );

    maybe(
      'five wrong codes lock the account; even the right code is refused until the lock lapses; both are audited',
      async () => {
        const row = await db!.adminMfaCredential.findUniqueOrThrow({ where: { userId: ids.sole } });
        const { decryptSecret } = await import('./mfa-crypto');
        const secret = decryptSecret(
          Buffer.from(MFA_KEY, 'base64'),
          row.secretCiphertext,
          ids.sole,
        );
        await db!.adminMfaCredential.updateMany({
          where: { userId: ids.sole },
          data: { failedAttempts: 0, lockedUntil: null },
        });
        const l = await login(emails.sole);
        for (let i = 0; i < 5; i++) {
          const bad = await http('POST', '/auth/mfa/verify', undefined, {
            challengeToken: l.json.challengeToken,
            code: '000000',
          });
          expect(bad.status).toBe(401);
        }
        const right = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: l.json.challengeToken,
          code: await code(ids.sole, secret, 0, true),
        });
        expect(right.status).toBe(429);
        expect(right.json.code).toBe('MFA_LOCKED');
        const audit = await db!.auditLog.findMany({
          where: { entityId: ids.sole, action: { in: ['MFA_VERIFY_FAILED', 'MFA_LOCKED_OUT'] } },
        });
        expect(
          audit.filter((a: { action: string }) => a.action === 'MFA_VERIFY_FAILED').length,
        ).toBeGreaterThanOrEqual(5);
        expect(audit.some((a: { action: string }) => a.action === 'MFA_LOCKED_OUT')).toBe(true);
        // The lock lapses by itself.
        await db!.adminMfaCredential.updateMany({
          where: { userId: ids.sole },
          data: { lockedUntil: new Date(Date.now() - 1000) },
        });
        const after = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: l.json.challengeToken,
          code: await code(ids.sole, secret, 0, true),
        });
        expect(after.status).toBeLessThan(300);
      },
    );
  });

  // ───────────────────────── 4. refresh ────────────────────────────────────────

  describe('refresh cannot mint a claim the session did not have', () => {
    maybe(
      'a rotation of a verified session stays verified, with the ORIGINAL verification time',
      async () => {
        const e = (secondEnroll = await enroll(emails.second));
        const decode = (t: string) =>
          JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
        const first = decode(e.tokens.accessToken);
        expect(first.amr).toEqual(['pwd', 'otp']);
        await new Promise((r) => setTimeout(r, 1100));
        const rot = await http('POST', '/auth/refresh', undefined, {
          refreshToken: e.tokens.refreshToken,
        });
        const second = decode(rot.json.accessToken);
        expect(second.mfaCid).toBe(first.mfaCid);
        expect(second.mfaAt).toBe(first.mfaAt); // not refreshed: step-up cannot be extended by rotating
        expect((await http('GET', '/admin/staff', rot.json.accessToken)).status).toBe(200);
      },
    );

    maybe(
      'a rotation of an UNVERIFIED session stays unverified (no claim appears from nowhere)',
      async () => {
        const row = await db!.adminMfaCredential.findUniqueOrThrow({
          where: { userId: ids.plain },
        });
        expect(row.confirmedAt).not.toBeNull();
        // An unbound refresh token for an enrolled admin: what a pre-deploy session looks like.
        const raw = randomBytes(32).toString('hex');
        await db!.refreshToken.create({
          data: {
            userId: ids.plain,
            tokenHash: createHash('sha256').update(raw).digest('hex'),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        const rot = await http('POST', '/auth/refresh', undefined, { refreshToken: raw });
        expect(rot.status).toBeLessThan(300);
        const claims = JSON.parse(
          Buffer.from(rot.json.accessToken.split('.')[1], 'base64url').toString(),
        );
        expect(claims.mfaCid).toBeUndefined();
        expect(claims.amr).toBeUndefined();
        const res = await http('GET', '/admin/staff', rot.json.accessToken);
        expect(res.json.code).toBe('MFA_REQUIRED');
        // Enrolled, so it cannot be used to enroll a second device either.
        const again = await http('POST', '/auth/mfa/enroll/start', rot.json.accessToken, {
          password: PASSWORD,
        });
        expect(again.status).toBe(409);
      },
    );
  });

  // ───────────────────────── 5. recovery codes ─────────────────────────────────

  describe('recovery codes', () => {
    maybe(
      'single use, audited, regenerable (old ones stop working)',
      async () => {
        const [first, second, third] = secondEnroll.recoveryCodes;
        expect(first).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

        const v = await signInWithRecovery(emails.second, first);
        expect(v.status).toBeLessThan(300);
        expect((await http('GET', '/admin/staff', v.json.accessToken)).status).toBe(200);
        const claims = JSON.parse(
          Buffer.from(v.json.accessToken.split('.')[1], 'base64url').toString(),
        );
        expect(claims.amr).toEqual(['pwd', 'rcv']);

        // Used once; the same code is dead (typed in lower case without the dash, still dead).
        const again = await signInWithRecovery(emails.second, first.replace('-', '').toLowerCase());
        expect(again.status).toBe(401);

        const status = await http('GET', '/auth/mfa/status', v.json.accessToken);
        expect(status.json).toMatchObject({
          enrolled: true,
          recoveryCodesRemaining: 9,
          verified: true,
        });

        // Regenerating needs a recent check (this session has one) and invalidates every old code.
        const regen = await http('POST', '/auth/mfa/recovery-codes/regenerate', v.json.accessToken);
        expect(regen.status).toBeLessThan(300);
        typed.push(...regen.json.recoveryCodes);
        expect(regen.json.recoveryCodes).toHaveLength(10);
        expect((await signInWithRecovery(emails.second, second)).status).toBe(401);
        expect((await signInWithRecovery(emails.second, third)).status).toBe(401);
        const fresh = await signInWithRecovery(emails.second, regen.json.recoveryCodes[0]);
        expect(fresh.status).toBeLessThan(300);

        const actions = (
          await db!.auditLog.findMany({ where: { entityId: ids.second }, select: { action: true } })
        ).map((a: { action: string }) => a.action);
        expect(actions).toEqual(
          expect.arrayContaining([
            'MFA_RECOVERY_CODE_USED',
            'MFA_RECOVERY_CODES_REGENERATED',
            'MFA_ENROLLMENT_COMPLETED',
          ]),
        );
        // Stored as slow hashes, never the code.
        const rows = await db!.adminMfaRecoveryCode.findMany({ where: { userId: ids.second } });
        expect(rows.every((r: { codeHash: string }) => r.codeHash.startsWith('$2'))).toBe(true);
      },
      180_000,
    );
  });

  // ───────────────────────── 6. step-up ────────────────────────────────────────

  describe('step-up for the most sensitive actions', () => {
    maybe('a stale second-factor check is refused until the code is given again', async () => {
      const cred = await db!.adminMfaCredential.findUniqueOrThrow({
        where: { userId: ids.second },
      });
      const stale = await new JwtService({}).signAsync(
        {
          sub: ids.second,
          email: emails.second,
          name: 'x',
          roles: ['CUSTOMER', 'SUPER_ADMIN'],
          amr: ['pwd', 'otp'],
          mfaCid: cred.id,
          mfaAt: Math.floor(Date.now() / 1000) - 20 * 60,
        },
        { secret: JWT_SECRET, expiresIn: '15m' },
      );
      // Ordinary admin reads still work on the stale session...
      expect((await http('GET', '/admin/staff', stale)).status).toBe(200);
      // ...but a change to who has power does not.
      const target = `/admin/staff/${ids.customer}/mfa/reset`;
      const refused = await http('POST', target, stale);
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('MFA_STEP_UP_REQUIRED');

      const secret = await secretOf(ids.second);
      await db!.adminMfaCredential.updateMany({
        where: { userId: ids.second },
        data: { lockedUntil: null, failedAttempts: 0 },
      });
      const up = await http('POST', '/auth/mfa/step-up', stale, {
        code: await code(ids.second, secret, 0, true),
      });
      expect(up.status).toBeLessThan(300);
      const ok = await http('POST', target, up.json.accessToken);
      expect(ok.status).toBeLessThan(300);
      // A wrong code does not step up.
      const bad = await http('POST', '/auth/mfa/step-up', stale, { code: '000000' });
      expect(bad.status).toBe(401);
    });
  });

  // ───────────────────────── 7. reset by another super admin ───────────────────

  describe('reset', () => {
    maybe(
      'another super admin resets; nobody resets themselves; a plain admin cannot',
      async () => {
        const secret = await secretOf(ids.second);
        await db!.adminMfaCredential.updateMany({
          where: { userId: ids.second },
          data: { lockedUntil: null, failedAttempts: 0 },
        });
        const l = await login(emails.second);
        const v = await http('POST', '/auth/mfa/verify', undefined, {
          challengeToken: l.json.challengeToken,
          code: await code(ids.second, secret, 0, true),
        });
        const actor = v.json.accessToken as string;

        const self = await http('POST', `/admin/staff/${ids.second}/mfa/reset`, actor);
        expect(self.status).toBe(403);
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.second } })).toBe(1);

        // `plain` is only an ADMIN (and holds no ADMIN_MANAGE): refused.
        const plainTry = await http(
          'POST',
          `/admin/staff/${ids.sole}/mfa/reset`,
          plainEnroll.tokens.accessToken,
        );
        expect(plainTry.status).toBe(403);
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.sole } })).toBe(1);

        const plainSession = plainEnroll.tokens;
        const done = await http('POST', `/admin/staff/${ids.plain}/mfa/reset`, actor);
        expect(done.status).toBeLessThan(300);
        // The target's sessions are gone and its authenticator with them.
        expect((await http('GET', '/admin/staff', plainSession.accessToken)).json.code).toBe(
          'MFA_REQUIRED',
        );
        expect(
          (
            await http('POST', '/auth/refresh', undefined, {
              refreshToken: plainSession.refreshToken,
            })
          ).status,
        ).toBe(401);
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.plain } })).toBe(0);
        // Next sign-in is an enrollment, not a lockout.
        const next = await login(emails.plain);
        expect(next.json.accessToken).toBeDefined();
        const e = await http('POST', '/auth/mfa/enroll/start', next.json.accessToken, {
          password: PASSWORD,
        });
        expect(e.status).toBeLessThan(300);

        const a = await db!.auditLog.findFirst({
          where: { action: 'MFA_RESET_BY_ADMIN', entityId: ids.plain },
        });
        expect(a?.actorUserId).toBe(ids.second);
      },
    );
  });

  // ───────────────────────── 8. break-glass ────────────────────────────────────

  describe('break-glass', () => {
    const nonce = `break-glass-nonce-${Date.now()}-aaaa`;
    async function service(over: Record<string, string>) {
      const { MfaService } = await import('./mfa.service');
      const { PrismaService } = await import('../../prisma/prisma.service');
      const { AuditService } = await import('../../audit/audit.service');
      const real = app!.get(PrismaService);
      const config = {
        get: (k: string) => over[k],
        getOrThrow: (k: string) => over[k] ?? JWT_SECRET,
      };
      return new MfaService(real, config as never, app!.get(AuditService), new JwtService({}));
    }

    maybe(
      'a sole admin who lost device and codes is recovered by the operator switch, once',
      async () => {
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.lost } })).toBe(1);
        expect((await login(emails.lost)).json.mfaRequired).toBe(true);

        const svc = await service({
          MFA_ENCRYPTION_KEY: MFA_KEY,
          MFA_BREAK_GLASS_EMAIL: emails.lost,
          MFA_BREAK_GLASS_NONCE: nonce,
        });
        await svc.runBreakGlass();
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.lost } })).toBe(0);
        const l = await login(emails.lost);
        expect(l.json.mfaRequired).toBeUndefined(); // password works; enrollment is next
        expect((await http('GET', '/admin/staff', l.json.accessToken)).json.code).toBe(
          'MFA_REQUIRED',
        );
        const audit = await db!.auditLog.findFirst({
          where: { action: 'MFA_BREAK_GLASS', entityId: ids.lost },
        });
        expect(audit).not.toBeNull();
        expect(audit?.actorUserId).toBeNull();
        expect(JSON.stringify(audit)).not.toContain(nonce);

        // They enroll again, and leaving the variables in place changes nothing on the next boot.
        await db!.refreshToken.deleteMany({ where: { userId: ids.lost } });
        await enroll(emails.lost);
        await svc.runBreakGlass();
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.lost } })).toBe(1);

        // A NEW nonce is a new, deliberate act.
        const again = await service({
          MFA_ENCRYPTION_KEY: MFA_KEY,
          MFA_BREAK_GLASS_EMAIL: emails.lost,
          MFA_BREAK_GLASS_NONCE: `${nonce}-second`,
        });
        await again.runBreakGlass();
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.lost } })).toBe(0);
      },
      120_000,
    );

    maybe(
      'acts only on a named back-office account: a customer or an unknown address is left alone and the nonce is not spent',
      async () => {
        const n = `${nonce}-other`;
        for (const email of [emails.customer, `nobody-${suffix}@test.invalid`]) {
          const s = await service({
            MFA_ENCRYPTION_KEY: MFA_KEY,
            MFA_BREAK_GLASS_EMAIL: email,
            MFA_BREAK_GLASS_NONCE: n,
          });
          await s.runBreakGlass();
        }
        const hash = createHash('sha256').update(`mfa-break-glass:${n}`).digest('hex');
        expect(await db!.adminMfaBreakGlassUse.count({ where: { nonceHash: hash } })).toBe(0);
        // And it never touches anybody else: `sole` is still enrolled after all of the above.
        expect(await db!.adminMfaCredential.count({ where: { userId: ids.sole } })).toBe(1);
      },
    );

    maybe('there is no HTTP route for it', async () => {
      for (const p of ['/auth/mfa/break-glass', '/auth/mfa/reset', '/admin/mfa/break-glass']) {
        expect([401, 403, 404]).toContain((await http('POST', p, undefined, {})).status);
      }
    });
  });

  // ───────────────────────── 9. nothing secret is written down ─────────────────

  describe('secrets', () => {
    maybe('no code, recovery code or authenticator secret appears in any audit row', async () => {
      expect(typed.length).toBeGreaterThan(15);
      const all = Object.values(ids);
      const rows = await db!.auditLog.findMany({
        where: { OR: [{ actorUserId: { in: all } }, { entityId: { in: all } }] },
      });
      expect(rows.length).toBeGreaterThan(10);
      const blob = JSON.stringify(rows);
      for (const t of typed) expect(blob).not.toContain(`"${t}"`);
      const creds = await db!.adminMfaCredential.findMany({ where: { userId: { in: all } } });
      for (const c of creds as Array<{ secretCiphertext: string }>) {
        expect(c.secretCiphertext).toMatch(/^v1\./);
      }
    });
  });

  async function secretOf(userId: string): Promise<Buffer> {
    const { decryptSecret } = await import('./mfa-crypto');
    const row = await db!.adminMfaCredential.findUniqueOrThrow({ where: { userId } });
    return decryptSecret(Buffer.from(MFA_KEY, 'base64'), row.secretCiphertext, userId);
  }
});
