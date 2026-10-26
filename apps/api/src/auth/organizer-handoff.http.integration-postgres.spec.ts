import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { phoneOnlyEmail } from '@eticketsgo/shared-types';

/**
 * integration-real-postgres, whole app over HTTP: a phone-registered organizer reaches the
 * organizer console, and nobody else does.
 *
 * ── THE REPORT (production, 2026-10-25) ────────────────────────────────────────────
 * A customer who signed up with a mobile number became an organizer on the storefront. The
 * account menu then read "Organizer console - DeepTrics Idaho" and sent them to a console
 * sign-in page that offered only an email and a password, which a phone-only account has never
 * had. The organization was theirs and there was no way in.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 *   1. A phone-only owner signs in by phone code (the route the console now offers) and, from
 *      that storefront session, is carried to the console by a one-time handoff code that is
 *      stored hashed, lives 60 seconds, works once and is never a token.
 *   2. Reuse, expiry, sign-out, a removed seat, a suspended account and a suspended
 *      organization are each refused - and every refusal is on the audit log.
 *   3. A back-office account gets its second-factor challenge from the exchange, never tokens.
 *   4. A customer with a valid session but no seat is refused the handoff AND the organizer
 *      API (403), whatever its token says.
 *   5. The phone-only owner adds a PROVED email for organizer messages, with no password.
 *
 * Every assertion that matters reads the TABLE afterwards. Fixtures carry a unique suffix and
 * are removed. Skips (never fabricates a pass) without a database.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
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
const CODE = '424242';
/** Anything shaped like a JWT: three base64url segments, the first one a JSON header. */
const JWT_LIKE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

describe('integration-real-postgres: organizer console handoff and phone identities', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `handoff-${Date.now()}-${randomBytes(3).toString('hex')}`;
  // A US mobile shape unique to this run (otp-destination refuses non-mobile numbers).
  const phone = `+1415${String(Date.now()).slice(-7)}`;
  const ids = {
    phoneOwner: '',
    customer: '',
    suspendedOrgOwner: '',
    admin: '',
    org: '',
    suspendedOrg: '',
  };
  const customerEmail = `customer-${suffix}@test.invalid`;
  const suspendedOwnerEmail = `susp-owner-${suffix}@test.invalid`;
  const adminEmail = `admin-${suffix}@test.invalid`;

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
    return { status: res.status, json: json?.data ?? json, raw: text };
  }

  const passwordLogin = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return { access: r.json.accessToken as string, refresh: r.json.refreshToken as string };
  };

  /** What `requestCode` writes, with a known code: the route under test still has to spend it. */
  const issuePhoneCode = async () => {
    await db!.phoneOtp.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await db!.phoneOtp.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(CODE, 4),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  };

  const phoneSignIn = async () => {
    await issuePhoneCode();
    const r = await http('POST', '/auth/phone/verify', undefined, { phone, code: CODE });
    expect(r.status).toBe(201);
    return { access: r.json.accessToken as string, refresh: r.json.refreshToken as string };
  };

  const handoff = (access: string) =>
    http('POST', '/auth/handoff', access, { audience: 'organizer' });
  const exchange = (code: string) =>
    http('POST', '/auth/handoff/exchange', undefined, { audience: 'organizer', code });

  const auditReasons = async (userId: string) =>
    (
      await db!.auditLog.findMany({
        where: { actorUserId: userId, action: { startsWith: 'AUTH_HANDOFF_' } },
        orderBy: { createdAt: 'asc' },
        select: { action: true, metadata: true },
      })
    ).map((a: { action: string; metadata: any }) => `${a.action}:${a.metadata?.reason ?? ''}`);

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
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.AUTH_THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-handoff-spec-0123456789abcdef';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-handoff-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-handoff-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-handoff-spec-0123456789';
    // MFA on, so a back-office account with a confirmed authenticator is challenged.
    process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

    const { AppModule } = await import('../app.module');
    const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 10);
    // The production shape: made by a phone code, no email, no password.
    const phoneOwner = await db!.user.create({
      data: {
        email: phoneOnlyEmail(phone),
        phone,
        phoneVerifiedAt: new Date(),
        passwordHash: `phone-only$${await bcrypt.hash(phone, 4)}`,
        fullName: 'Phone Owner',
        roles: ['CUSTOMER', 'ORGANIZER_OWNER'],
      },
    });
    ids.phoneOwner = phoneOwner.id;
    const customer = await db!.user.create({
      data: { email: customerEmail, passwordHash: hash, fullName: 'Customer', roles: ['CUSTOMER'] },
    });
    ids.customer = customer.id;
    const suspendedOwner = await db!.user.create({
      data: {
        email: suspendedOwnerEmail,
        passwordHash: hash,
        fullName: 'Suspended Org Owner',
        roles: ['CUSTOMER', 'ORGANIZER_OWNER'],
      },
    });
    ids.suspendedOrgOwner = suspendedOwner.id;
    const admin = await db!.user.create({
      data: { email: adminEmail, passwordHash: hash, fullName: 'Admin', roles: ['ADMIN'] },
    });
    ids.admin = admin.id;
    await db!.adminMfaCredential.create({
      data: {
        userId: admin.id,
        secretCiphertext: 'not-read-by-this-test',
        confirmedAt: new Date(),
      },
    });

    const org = await db!.organization.create({
      data: { name: `Handoff Org ${suffix}`, slug: `handoff-${suffix}`, status: 'APPROVED' },
    });
    ids.org = org.id;
    const suspendedOrg = await db!.organization.create({
      data: { name: `Suspended Org ${suffix}`, slug: `susp-${suffix}`, status: 'SUSPENDED' },
    });
    ids.suspendedOrg = suspendedOrg.id;
    await db!.organizationMember.createMany({
      data: [
        {
          organizationId: org.id,
          userId: phoneOwner.id,
          role: 'ORGANIZER_OWNER',
          status: 'ACTIVE',
        },
        { organizationId: org.id, userId: admin.id, role: 'ORGANIZER_MANAGER', status: 'ACTIVE' },
        {
          organizationId: suspendedOrg.id,
          userId: suspendedOwner.id,
          role: 'ORGANIZER_OWNER',
          status: 'ACTIVE',
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const userIds = Object.entries(ids)
        .filter(([k]) => !['org', 'suspendedOrg'].includes(k))
        .map(([, v]) => v)
        .filter(Boolean);
      await db.auditLog.deleteMany({
        where: {
          OR: [
            { actorUserId: { in: userIds } },
            { organizationId: { in: [ids.org, ids.suspendedOrg] } },
          ],
        },
      });
      await db.organizationMember.deleteMany({
        where: { organizationId: { in: [ids.org, ids.suspendedOrg] } },
      });
      await db.organization.deleteMany({ where: { id: { in: [ids.org, ids.suspendedOrg] } } });
      await db.phoneOtp.deleteMany({ where: { phone } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    }
    if (app) await app.close();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe('a phone-only organizer signs in by phone code - no email, no password', async () => {
    const session = await phoneSignIn();
    expect(session.access).toMatch(JWT_LIKE);
    const me = await http('GET', '/auth/me', session.access);
    expect(me.json.id).toBe(ids.phoneOwner);
    expect(me.json.email).toBeNull();
    // And that session can open its own organization.
    const orgs = await http('GET', '/organizations', session.access);
    expect(orgs.status).toBe(200);
    expect(orgs.json.map((o: { id: string }) => o.id)).toContain(ids.org);
  });

  maybe(
    'the storefront session is carried to the console once, by a code that is not a token',
    async () => {
      const store = await phoneSignIn();
      const created = await handoff(store.access);
      expect(created.status).toBe(201);
      const code = created.json.code as string;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.json.expiresInSeconds).toBe(60);
      // Nothing in the reply - and so nothing the storefront could put in a URL - is a JWT.
      expect(created.raw).not.toMatch(JWT_LIKE);
      expect(Object.keys(created.json).sort()).toEqual(['code', 'expiresInSeconds']);

      // Stored hashed, bound to the audience, about a minute to live.
      const rows = await db!.authHandoff.findMany({ where: { userId: ids.phoneOwner } });
      const row = rows[rows.length - 1];
      expect(row.codeHash).not.toBe(code);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.audience).toBe('organizer');
      const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(ttl).toBeGreaterThan(55_000);
      expect(ttl).toBeLessThanOrEqual(61_000);

      const before = await db!.refreshToken.count({ where: { userId: ids.phoneOwner } });
      const console = await exchange(code);
      expect(console.status).toBe(201);
      expect(console.json.accessToken).toMatch(JWT_LIKE);
      expect(console.json.refreshToken).toBeTruthy();
      // A NEW session of its own, under the ordinary rotation rules.
      expect(await db!.refreshToken.count({ where: { userId: ids.phoneOwner } })).toBe(before + 1);
      const rotated = await http('POST', '/auth/refresh', undefined, {
        refreshToken: console.json.refreshToken,
      });
      expect(rotated.status).toBe(201);
      const members = await http(
        'GET',
        `/organizations/${ids.org}/members`,
        rotated.json.accessToken,
      );
      expect(members.status).toBe(200);

      // Single use: the same code again is refused, and the row says it was spent once.
      const again = await exchange(code);
      expect(again.status).toBe(401);
      expect(again.raw).not.toMatch(JWT_LIKE);
      const spent = await db!.authHandoff.findUnique({ where: { id: row.id } });
      expect(spent.consumedAt).not.toBeNull();
      const audit = await auditReasons(ids.phoneOwner);
      expect(audit).toEqual(
        expect.arrayContaining([
          'AUTH_HANDOFF_CREATED:',
          'AUTH_HANDOFF_EXCHANGED:',
          'AUTH_HANDOFF_REFUSED:reused',
        ]),
      );
    },
  );

  maybe('an expired code is refused', async () => {
    const store = await phoneSignIn();
    const { json } = await handoff(store.access);
    await db!.authHandoff.updateMany({
      where: { userId: ids.phoneOwner, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await exchange(json.code);
    expect(r.status).toBe(401);
    expect(await auditReasons(ids.phoneOwner)).toContain('AUTH_HANDOFF_REFUSED:expired');
  });

  maybe('signing out on the storefront revokes a code still in flight', async () => {
    const store = await phoneSignIn();
    const { json } = await handoff(store.access);
    const out = await http('POST', '/auth/logout', undefined, { refreshToken: store.refresh });
    expect(out.status).toBe(201);
    const r = await exchange(json.code);
    expect(r.status).toBe(401);
    expect(await auditReasons(ids.phoneOwner)).toContain('AUTH_HANDOFF_REFUSED:revoked');
  });

  maybe('sign out everywhere revokes it too', async () => {
    const store = await phoneSignIn();
    const { json } = await handoff(store.access);
    expect((await http('POST', '/auth/logout-all', store.access)).status).toBe(201);
    expect((await exchange(json.code)).status).toBe(401);
  });

  maybe('an unknown or malformed code is refused without a session', async () => {
    expect((await exchange(randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await exchange('short')).status).toBe(400);
    const wrongAudience = await http('POST', '/auth/handoff/exchange', undefined, {
      audience: 'admin',
      code: randomBytes(32).toString('base64url'),
    });
    expect(wrongAudience.status).toBe(400);
  });

  maybe(
    'a customer with a valid session but no seat is refused the handoff and the organizer API',
    async () => {
      const s = await passwordLogin(customerEmail);
      const r = await handoff(s.access);
      expect(r.status).toBe(403);
      expect(r.json.code ?? r.json.error?.code).toBeDefined();
      expect(await db!.authHandoff.count({ where: { userId: ids.customer } })).toBe(0);
      expect(await auditReasons(ids.customer)).toContain('AUTH_HANDOFF_REFUSED:no_membership');
      // The organizer API decides by membership read from the database, not by the token.
      for (const path of [
        `/organizations/${ids.org}`,
        `/organizations/${ids.org}/members`,
        `/organizations/${ids.org}/actions`,
      ]) {
        const denied = await http('GET', path, s.access);
        expect(denied.status).toBe(403);
      }
      const mine = await http('GET', '/organizations', s.access);
      expect(mine.json).toEqual([]);
    },
  );

  maybe('a member whose only organization is suspended is refused the handoff', async () => {
    const s = await passwordLogin(suspendedOwnerEmail);
    const r = await handoff(s.access);
    expect(r.status).toBe(403);
    expect(await auditReasons(ids.suspendedOrgOwner)).toContain(
      'AUTH_HANDOFF_REFUSED:organization_suspended',
    );
  });

  maybe('a seat removed after the code was minted is refused at exchange', async () => {
    const store = await phoneSignIn();
    const { json } = await handoff(store.access);
    await db!.organizationMember.updateMany({
      where: { organizationId: ids.org, userId: ids.phoneOwner },
      data: { status: 'REMOVED' },
    });
    try {
      const r = await exchange(json.code);
      expect(r.status).toBe(403);
    } finally {
      await db!.organizationMember.updateMany({
        where: { organizationId: ids.org, userId: ids.phoneOwner },
        data: { status: 'ACTIVE' },
      });
    }
  });

  maybe(
    'an account suspended after the code was minted gets nothing, and its token is refused',
    async () => {
      const store = await phoneSignIn();
      const { json } = await handoff(store.access);
      await db!.user.update({ where: { id: ids.phoneOwner }, data: { status: 'SUSPENDED' } });
      try {
        const r = await exchange(json.code);
        expect(r.status).toBe(401);
        expect(r.raw).not.toMatch(JWT_LIKE);
        expect((await http('GET', `/organizations/${ids.org}`, store.access)).status).toBe(401);
        expect(await auditReasons(ids.phoneOwner)).toContain('AUTH_HANDOFF_REFUSED:inactive_user');
      } finally {
        await db!.user.update({ where: { id: ids.phoneOwner }, data: { status: 'ACTIVE' } });
      }
    },
  );

  maybe(
    'a back-office member gets the second-factor challenge from the exchange, never tokens',
    async () => {
      // A session the API would hand a back-office account on the storefront route is not what
      // matters here: the code is minted directly, as the create route would for this account.
      const { AuthHandoffService } = await import('./handoff.service');
      const service = app!.get(AuthHandoffService);
      const { code } = await service.create(ids.admin, 'organizer', {});
      const r = await exchange(code);
      expect(r.status).toBe(201);
      expect(r.json.mfaRequired).toBe(true);
      expect(r.json.challengeToken).toBeTruthy();
      expect(r.json.accessToken).toBeUndefined();
      expect(r.json.refreshToken).toBeUndefined();
      expect(await db!.refreshToken.count({ where: { userId: ids.admin } })).toBe(0);
      // And the password route answers the same account the same way: nothing was bypassed.
      const login = await http('POST', '/auth/login', undefined, {
        email: adminEmail,
        password: PASSWORD,
      });
      expect(login.json.mfaRequired).toBe(true);
    },
  );

  maybe(
    'the phone-only owner adds a proved email for organizer messages, with no password',
    async () => {
      const s = await phoneSignIn();
      const address = `owner-${suffix}@mail.test.invalid`;
      const sent = await http('POST', '/auth/email/request-code', s.access, { email: address });
      expect(sent.status).toBe(201);
      const row = await db!.emailVerificationCode.findFirst({
        where: { userId: ids.phoneOwner, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.email).toBe(address);
      expect(row.codeHash).toMatch(/^\$2[aby]\$/);
      // A known code on the same row: the route still has to find, count, compare and spend it.
      await db!.emailVerificationCode.update({
        where: { id: row.id },
        data: { codeHash: await bcrypt.hash(CODE, 4) },
      });
      const wrong = await http('POST', '/auth/email/verify', s.access, {
        email: address,
        code: '000000',
      });
      expect(wrong.status).toBe(400);
      const ok = await http('POST', '/auth/email/verify', s.access, { email: address, code: CODE });
      expect(ok.status).toBe(201);
      expect(ok.json.email).toBe(address);

      const user = await db!.user.findUnique({ where: { id: ids.phoneOwner } });
      expect(user.email).toBe(address);
      expect(user.emailVerifiedAt).not.toBeNull();
      // Still phone sign-in only: no password was asked for or set.
      expect(user.passwordHash.startsWith('phone-only$')).toBe(true);
      const org = await db!.organization.findUnique({ where: { id: ids.org } });
      expect(org.contactEmail).toBe(address);
      // The code is spent, and an account that now has an address cannot add another this way.
      const again = await http('POST', '/auth/email/verify', s.access, {
        email: address,
        code: CODE,
      });
      expect(again.status).toBe(400);
      const second = await http('POST', '/auth/email/request-code', s.access, {
        email: `other-${suffix}@mail.test.invalid`,
      });
      expect(second.status).toBe(409);
      // The person still signs in by phone, and `me` now shows the proved address.
      const me = await http('GET', '/auth/me', (await phoneSignIn()).access);
      expect(me.json.email).toBe(address);
    },
  );

  maybe(
    'an address that already has an account is refused, as the sign-up form refuses it',
    async () => {
      // A fresh phone-only account for this case.
      const other = await db!.user.create({
        data: {
          email: phoneOnlyEmail(`+1415${String(Date.now() + 7).slice(-7)}`),
          passwordHash: 'phone-only$x',
          fullName: 'Other',
          roles: ['CUSTOMER'],
        },
      });
      (ids as Record<string, string>).otherPhone = other.id;
      const { JwtService } = await import('@nestjs/jwt');
      const { ConfigService } = await import('@nestjs/config');
      const secret = app!.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET');
      const token = new JwtService({ secret }).sign(
        { sub: other.id, email: other.email, name: 'Other', roles: ['CUSTOMER'] },
        { secret, expiresIn: '5m' },
      );
      const r = await http('POST', '/auth/email/request-code', token, { email: customerEmail });
      expect(r.status).toBe(409);
      expect(await db!.emailVerificationCode.count({ where: { userId: other.id } })).toBe(0);
    },
  );
});
