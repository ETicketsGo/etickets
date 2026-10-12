import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ADMIN_PRESETS } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Separation of duties on payouts: the person who verified a bank account never pays into it.
 *
 * Real HTTP, real signed tokens, the real guards, a real database. Before this change one
 * PAYOUT_MANAGE holder (and any super admin) could verify an account and also mark the payout
 * paid; the "verifies, then is refused as payer" tests fail on that behaviour.
 */

function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function infrastructureReachable(databaseUrl: string, redisUrl: string): Promise<boolean> {
  const { PrismaClient } = require('@prisma/client');
  const IORedis = require('ioredis');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await db.$queryRaw`SELECT 1`;
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
}

type Actor =
  | 'owner'
  | 'verifierA'
  | 'payerB'
  | 'both'
  | 'superA'
  | 'superB'
  | 'reviewer'
  | 'oncall'
  | 'legacyFinance';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

describe('integration-real-postgres: finance separation of duties', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `sod${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<Actor, string>;
  const tokens = {} as Record<Actor, string>;
  let orgId = '';
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    const url = loadEnvValue('DATABASE_URL');
    const redis = loadEnvValue('REDIS_URL');
    if (!url || !redis || !(await infrastructureReachable(url, redis))) {
      console.warn('[integration-real-postgres] SKIPPED - PostgreSQL/Redis not reachable');
      return;
    }
    Object.assign(process.env, {
      DATABASE_URL: url,
      REDIS_URL: redis,
      APP_ENV: 'LOCAL',
      PAYMENT_PROVIDER_NAME: 'mock',
      THROTTLE_LIMIT: '100000',
      PAYOUT_BANK_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    if (!process.env.JWT_ACCESS_SECRET) {
      process.env.JWT_ACCESS_SECRET = loadEnvValue('JWT_ACCESS_SECRET');
    }
    const { AppModule } = require('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    const makeUser = async (key: Actor, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key}-${suffix}@sod.test`.toLowerCase(),
          passwordHash: 'x',
          fullName: `${key} ${suffix}`,
          roles: roles as never,
        },
      });
      for (const permission of new Set(grants)) {
        await prisma.adminGrant.create({ data: { userId: user.id, permission } });
      }
      ids[key] = user.id;
      tokens[key] = jwt.sign(
        { sub: user.id, email: user.email, name: user.fullName, roles },
        { expiresIn: '30m' },
      );
    };
    await makeUser('owner', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('verifierA', ['ADMIN'], [...ADMIN_PRESETS.FINANCE_VERIFIER.grants]);
    await makeUser('payerB', ['ADMIN'], [...ADMIN_PRESETS.FINANCE_PAYER.grants]);
    // Misconfigured on purpose: holds BOTH duties. The identity rule must still hold.
    await makeUser(
      'both',
      ['ADMIN'],
      [...ADMIN_PRESETS.FINANCE_VERIFIER.grants, ...ADMIN_PRESETS.FINANCE_PAYER.grants],
    );
    await makeUser('superA', ['ADMIN', 'SUPER_ADMIN']);
    await makeUser('superB', ['ADMIN', 'SUPER_ADMIN']);
    await makeUser('reviewer', ['ADMIN'], [...ADMIN_PRESETS.FINANCE_REVIEWER.grants]);
    await makeUser('oncall', ['ADMIN'], [...ADMIN_PRESETS.OPS_ONCALL.grants]);
    // The FINANCE preset exactly as it ships: PAYOUT_MANAGE, but neither new duty.
    await makeUser('legacyFinance', ['ADMIN'], [...ADMIN_PRESETS.FINANCE.grants]);
    orgId = (
      await prisma.organization.create({
        data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
      })
    ).id;
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: ids.owner, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorUserId: { in: userIds } }, { organizationId: orgId }] },
      });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payout.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  async function call(actor: Actor, method: string, path: string, body?: unknown): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  }

  const newPayout = (netMinor = 10_000) =>
    prisma.payout.create({
      data: {
        organizationId: orgId,
        currency: 'INR',
        netMinor,
        grossMinor: netMinor,
        status: 'PENDING',
      },
    });
  const statusOf = async (id: string) =>
    (await prisma.payout.findUniqueOrThrow({ where: { id } })).status;
  const pay = (id: string, actor: Actor) =>
    call(actor, 'POST', `/admin/payouts/${id}/pay`, { reference: 'UTR-SOD' });
  const saveAccount = (accountNumber: string) =>
    call('owner', 'POST', '/payouts/accounts', {
      organizationId: orgId,
      currency: 'INR',
      holderName: 'Org Legal',
      bankName: 'HDFC Bank',
      bankCode: 'HDFC0001234',
      accountNumber,
    });
  const accountRow = () =>
    prisma.organizerPayoutAccount.findUniqueOrThrow({
      where: { organizationId_currency: { organizationId: orgId, currency: 'INR' } },
    });
  const verify = async (actor: Actor) => {
    const acc = await accountRow();
    return call(actor, 'POST', `/admin/payouts/accounts/${acc.id}/verified`, {
      version: acc.version,
    });
  };
  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  it('Finance A verifies, then cannot pay: no PAYOUT_EXECUTE, nothing changes', async () => {
    if (skip()) return;
    expect((await saveAccount('501001234567')).status).toBe(201);
    expect((await verify('verifierA')).status).toBe(201);
    expect((await accountRow()).verifiedByUserId).toBe(ids.verifierA);
    const p = await newPayout();
    const res = await pay(p.id, 'verifierA');
    expect(res.status).toBe(403);
    expect(await statusOf(p.id)).toBe('PENDING');
  });

  it('Finance B pays into the account Finance A verified', async () => {
    if (skip()) return;
    const [p] = await prisma.payout.findMany({ where: { organizationId: orgId } });
    const res = await pay(p.id, 'payerB');
    expect(res.status).toBe(201);
    expect(await statusOf(p.id)).toBe('PAID');
  });

  it('Finance B cannot verify or reject an account', async () => {
    if (skip()) return;
    await saveAccount('998877665544');
    const acc = await accountRow();
    for (const path of ['verified', 'reject']) {
      const res = await call('payerB', 'POST', `/admin/payouts/accounts/${acc.id}/${path}`, {
        version: acc.version,
        reason: 'x',
      });
      expect(res.status).toBe(403);
    }
    expect((await accountRow()).verifiedAt).toBeNull();
  });

  it('a person holding BOTH duties verifies, then is refused as payer: 403, reason, audit row', async () => {
    if (skip()) return;
    expect((await verify('both')).status).toBe(201);
    const p = await newPayout(20_000);
    const res = await pay(p.id, 'both');
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ hold: 'VERIFIER_CANNOT_PAY' });
    expect(res.body.message).toContain('someone else must mark this payout paid');
    expect(await statusOf(p.id)).toBe('PENDING');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: p.id, action: 'PAYOUT_PAID', actorUserId: ids.both },
    });
    expect(audit.metadata).toMatchObject({
      outcome: 'REFUSED',
      reasonCode: 'VERIFIER_CANNOT_PAY',
    });
    // The other person can.
    expect((await pay(p.id, 'payerB')).status).toBe(201);
    expect(await statusOf(p.id)).toBe('PAID');
  });

  it('a SUPER ADMIN who verified cannot pay either; another super admin can', async () => {
    if (skip()) return;
    await saveAccount('112233445566');
    expect((await verify('superA')).status).toBe(201);
    const p = await newPayout(30_000);
    const refused = await pay(p.id, 'superA');
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ hold: 'VERIFIER_CANNOT_PAY' });
    expect(await statusOf(p.id)).toBe('PENDING');
    expect((await pay(p.id, 'superB')).status).toBe(201);
  });

  it('is judged on the version being paid: someone else verifying a new version frees the first verifier', async () => {
    if (skip()) return;
    await saveAccount('665544332211');
    expect((await verify('superA')).status).toBe(201);
    const p = await newPayout(40_000);
    expect((await pay(p.id, 'superA')).status).toBe(403);
    // The owner changes the details; somebody else verifies the NEW version.
    await saveAccount('121212121212');
    expect((await verify('superB')).status).toBe(201);
    expect((await pay(p.id, 'superA')).status).toBe(201);
  });

  it('a payout that sends nothing to the organizer has no destination to protect', async () => {
    if (skip()) return;
    await saveAccount('343434343434');
    expect((await verify('superA')).status).toBe(201);
    const clawback = await newPayout(-500);
    expect((await pay(clawback.id, 'superA')).status).toBe(201);
  });

  it('reviewer and on-call cannot verify, reject, reveal, pay, fail, release, or see bank accounts', async () => {
    if (skip()) return;
    const acc = await accountRow();
    const p = await newPayout(1_000);
    for (const actor of ['reviewer', 'oncall'] as const) {
      const attempts: [string, string, unknown?][] = [
        ['POST', `/admin/payouts/accounts/${acc.id}/verified`, { version: acc.version }],
        ['POST', `/admin/payouts/accounts/${acc.id}/reject`, { version: acc.version, reason: 'x' }],
        ['POST', `/admin/payouts/accounts/${acc.id}/reveal`, { reason: 'x' }],
        ['POST', `/admin/payouts/${p.id}/pay`, {}],
        ['POST', `/admin/payouts/${p.id}/fail`, { reason: 'x' }],
        ['POST', '/admin/settlements/missing/approve'],
        ['POST', '/admin/settlements/missing/release', {}],
        ['GET', '/admin/payouts/accounts'],
        ['GET', '/admin/payouts'],
      ];
      for (const [method, path, body] of attempts) {
        expect({ actor, path, status: (await call(actor, method, path, body)).status }).toEqual({
          actor,
          path,
          status: 403,
        });
      }
    }
    expect(await statusOf(p.id)).toBe('PENDING');
  });

  it('the shipped FINANCE preset (PAYOUT_MANAGE only) keeps its reads and loses verify, pay, fail and release', async () => {
    if (skip()) return;
    const acc = await accountRow();
    const p = await newPayout(1_000);
    expect((await call('legacyFinance', 'GET', '/admin/payouts/accounts')).status).toBe(200);
    expect((await call('legacyFinance', 'GET', '/admin/settlements')).status).toBe(200);
    expect((await pay(p.id, 'legacyFinance')).status).toBe(403);
    expect(
      (await call('legacyFinance', 'POST', `/admin/payouts/${p.id}/fail`, { reason: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await call('legacyFinance', 'POST', `/admin/payouts/accounts/${acc.id}/verified`, {
          version: acc.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('legacyFinance', 'POST', '/admin/settlements/missing/release', {})).status,
    ).toBe(403);
    // Block stays a PAYOUT_MANAGE action (it stops money, it does not move it).
    expect(
      (await call('legacyFinance', 'POST', '/admin/settlements/missing/block', { reason: 'x' }))
        .status,
    ).not.toBe(403);
  });

  it('the payer reaches settlement approve (404 for a missing id, not 403); the verifier does not', async () => {
    if (skip()) return;
    expect((await call('payerB', 'POST', '/admin/settlements/missing/approve')).status).not.toBe(
      403,
    );
    expect((await call('verifierA', 'POST', '/admin/settlements/missing/approve')).status).toBe(
      403,
    );
  });
});
