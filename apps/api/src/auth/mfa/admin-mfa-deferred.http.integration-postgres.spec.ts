import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { base32Decode, hotp, stepFor } from './totp';

/**
 * integration-real-postgres, whole app over HTTP: MFA_ENROLLMENT=deferred.
 *
 * The owner's launch decision, asserted through the real guards, strategy and database:
 *   - staff sign in with a password and use the ordinary back office without enrolling;
 *   - the sensitive actions are NOT relaxed: with no key they are blocked (MFA_NOT_CONFIGURED),
 *     with a key they need setup first (MFA_SETUP_REQUIRED), and each refusal is audited;
 *   - after enrolling and a fresh code they open, and the enrolled account is then held to the
 *     full rule (challenged at sign-in, step-up when the check goes stale);
 *   - customers, organizers and the role check are untouched.
 *
 * `required` mode is admin-mfa.http.integration-postgres.spec.ts, unchanged. The config is
 * validated once per file (ConfigModule cache), so this file sets MFA_ENROLLMENT before its first
 * boot and never changes it. Skips (never fabricates a pass) without a database.
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

const PASSWORD = 'Copper-Harbour-7391!';
const MFA_KEY = randomBytes(32).toString('base64');
const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-for-admin-mfa-deferred';

/** Three of the step-up routes: money out, where payments go, and paying an organizer. */
const SENSITIVE: Array<[string, string, unknown]> = [
  ['POST', '/refunds/no-such-refund/process', { decision: 'APPROVE' }],
  ['PATCH', '/admin/payments/config/no-such-config', { enabled: false }],
  ['POST', '/admin/payouts/no-such-payout/pay', {}],
];
const MFA_CODES = [
  'MFA_REQUIRED',
  'MFA_STEP_UP_REQUIRED',
  'MFA_SETUP_REQUIRED',
  'MFA_NOT_CONFIGURED',
];

describe('integration-real-postgres: admin MFA with MFA_ENROLLMENT=deferred', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `mfa-def-${Date.now()}`;
  const emails = {
    boss: `boss-${suffix}@test.invalid`,
    customer: `cust-${suffix}@test.invalid`,
    organizer: `org-${suffix}@test.invalid`,
  };
  const ids: Record<string, string> = {};

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
    process.env.MFA_ENROLLMENT = 'deferred';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.AUTH_THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET = JWT_SECRET;
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-admin-mfa-deferred-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-admin-mfa-deferred-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-admin-mfa-deferred-0123456789';
    if (withKey) process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
    else delete process.env.MFA_ENCRYPTION_KEY;
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

  const refusals = (reason: string) =>
    db!.auditLog
      .findMany({
        where: { actorUserId: ids.boss, action: 'MFA_SENSITIVE_ACTION_REFUSED' },
        select: { metadata: true },
      })
      .then((rows: Array<{ metadata: { reason?: string } }>) =>
        rows.filter((r) => r.metadata?.reason === reason),
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
      ids[key] = u.id;
    };
    await mk('boss', ['CUSTOMER', 'SUPER_ADMIN']);
    await mk('customer', ['CUSTOMER']);
    await mk('organizer', ['CUSTOMER', 'ORGANIZER_OWNER']);
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      const uids = Object.values(ids);
      await db.auditLog.deleteMany({ where: { actorUserId: { in: uids } } });
      await db.auditLog.deleteMany({ where: { entityId: { in: uids } } });
      await db.user.deleteMany({ where: { id: { in: uids } } });
      await db.$disconnect();
    }
    if (app) await app.close();
    delete process.env.MFA_ENCRYPTION_KEY;
    delete process.env.MFA_ENROLLMENT;
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

  // ───────────────────────── no key: sign in, but sensitive actions are BLOCKED ──────────

  maybe('no key: staff sign in with a password and use the ordinary back office', async () => {
    await boot(false);
    const l = await login(emails.boss);
    expect(l.status).toBeLessThan(300);
    expect(l.json.mfaRequired).toBeUndefined();
    expect((await http('GET', '/admin/staff', l.json.accessToken)).status).toBe(200);
    const me = await http('GET', '/auth/me', l.json.accessToken);
    expect(me.json.mfa).toMatchObject({ required: false, stepUp: 'unconfigured' });
    // Not hidden from a password-only session: deferred lets them do the ordinary work.
    expect(me.json.adminPermissions?.length).toBeGreaterThan(0);
  });

  maybe(
    'no key: every sensitive action is refused MFA_NOT_CONFIGURED (never skipped) and audited',
    async () => {
      const token = (await login(emails.boss)).json.accessToken;
      for (const [method, path, body] of SENSITIVE) {
        const r = await http(method, path, token, body);
        expect({ path, status: r.status, code: r.json.code }).toEqual({
          path,
          status: 403,
          code: 'MFA_NOT_CONFIGURED',
        });
      }
      const rows = await refusals('not_configured');
      expect(rows.length).toBe(SENSITIVE.length);
      expect(rows.map((r: any) => r.metadata.operation).sort()).toEqual(
        [
          'AdminPayoutsController.pay',
          'PaymentAdminController.updateConfig',
          'RefundsController.process',
        ].sort(),
      );
      expect(rows[0].metadata).toMatchObject({ enrollment: 'deferred' });
    },
  );

  maybe('no key: nothing can be enrolled, so no secret is ever stored', async () => {
    const token = (await login(emails.boss)).json.accessToken;
    const start = await http('POST', '/auth/mfa/enroll/start', token, { password: PASSWORD });
    expect(start.status).toBe(503);
    expect(await db!.adminMfaCredential.count({ where: { userId: ids.boss } })).toBe(0);
  });

  maybe('no key: customers, organizers and the role check are untouched', async () => {
    const c = await login(emails.customer);
    expect(c.status).toBeLessThan(300);
    expect(c.json.accessToken).toBeDefined();
    const o = await login(emails.organizer);
    expect(o.json.accessToken).toBeDefined();
    for (const token of [c.json.accessToken, o.json.accessToken]) {
      const staff = await http('GET', '/admin/staff', token);
      expect(staff.status).toBe(403);
      expect(MFA_CODES).not.toContain(staff.json.code);
      const pay = await http('POST', '/admin/payouts/no-such-payout/pay', token, {});
      expect(pay.status).toBe(403);
      expect(MFA_CODES).not.toContain(pay.json.code);
    }
  });

  // ───────────────────────── key set: setup first, then the actions open ─────────────────

  let enrolled: { secret: Buffer; accessToken: string } | undefined;

  maybe(
    'key set, not enrolled: ordinary work goes on, sensitive actions ask for setup (audited)',
    async () => {
      await boot(true);
      const l = await login(emails.boss);
      expect(l.json.mfaRequired).toBeUndefined();
      const token = l.json.accessToken;
      expect((await http('GET', '/admin/staff', token)).status).toBe(200);
      const me = await http('GET', '/auth/me', token);
      expect(me.json.mfa).toMatchObject({
        required: false,
        enrolled: false,
        stepUp: 'available',
      });
      for (const [method, path, body] of SENSITIVE) {
        const r = await http(method, path, token, body);
        expect({ path, status: r.status, code: r.json.code }).toEqual({
          path,
          status: 403,
          code: 'MFA_SETUP_REQUIRED',
        });
        expect(r.json.message).toMatch(/Set up two-step sign-in/);
      }
      expect((await refusals('not_enrolled')).length).toBe(SENSITIVE.length);
    },
  );

  maybe('key set: enrolling from the same session opens the sensitive actions', async () => {
    const token = (await login(emails.boss)).json.accessToken;
    const start = await http('POST', '/auth/mfa/enroll/start', token, { password: PASSWORD });
    expect(start.status).toBeLessThan(300);
    const secret = base32Decode(start.json.secret);
    const confirm = await http('POST', '/auth/mfa/enroll/confirm', token, {
      code: hotp(secret, stepFor(Date.now())),
    });
    expect(confirm.status).toBeLessThan(300);
    enrolled = { secret, accessToken: confirm.json.accessToken };
    const row = await db!.adminMfaCredential.findUniqueOrThrow({ where: { userId: ids.boss } });
    expect(row.secretCiphertext).toMatch(/^v1\./);

    for (const [method, path, body] of SENSITIVE) {
      const r = await http(method, path, enrolled.accessToken, body);
      // Past MfaGuard: whatever the handler says about a made-up id, it is not an MFA refusal.
      expect({ path, code: MFA_CODES.includes(r.json.code) ? r.json.code : 'passed' }).toEqual({
        path,
        code: 'passed',
      });
    }
  });

  maybe('key set, enrolled: the account is held to the full rule', async () => {
    // Sign-in now demands the code...
    const l = await login(emails.boss);
    expect(l.json.mfaRequired).toBe(true);
    expect(l.json.accessToken).toBeUndefined();
    // ...a session that never proved it is refused everywhere, not only on sensitive routes...
    const cred = await db!.adminMfaCredential.findUniqueOrThrow({ where: { userId: ids.boss } });
    const sign = (claims: object) =>
      new JwtService({}).signAsync(
        {
          sub: ids.boss,
          email: emails.boss,
          name: 'x',
          roles: ['CUSTOMER', 'SUPER_ADMIN'],
          ...claims,
        },
        { secret: JWT_SECRET, expiresIn: '15m' },
      );
    const noClaim = await sign({});
    expect((await http('GET', '/admin/staff', noClaim)).json.code).toBe('MFA_REQUIRED');
    // ...and a stale check opens the console but not the money.
    const stale = await sign({
      amr: ['pwd', 'otp'],
      mfaCid: cred.id,
      mfaAt: Math.floor(Date.now() / 1000) - 20 * 60,
    });
    expect((await http('GET', '/admin/staff', stale)).status).toBe(200);
    const [method, path, body] = SENSITIVE[1];
    expect((await http(method, path, stale, body)).json.code).toBe('MFA_STEP_UP_REQUIRED');
  });

  maybe('key set: customers and organizers still sign in with a password only', async () => {
    for (const email of [emails.customer, emails.organizer]) {
      const l = await login(email);
      expect(l.json.mfaRequired).toBeUndefined();
      expect(l.json.accessToken).toBeDefined();
    }
  });
});
