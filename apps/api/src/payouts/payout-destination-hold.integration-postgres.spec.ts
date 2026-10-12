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
 * A payout is not marked PAID to a bank account nobody independent has verified.
 *
 * Through the whole application on a real database: real HTTP, real signed tokens, the real
 * `FOR SHARE` lock. The behaviour BEFORE this change (a payout could be marked paid with no
 * account at all, or with one saved a moment earlier and never checked) is what these tests
 * fail on if the hold is removed.
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

type Actor = 'owner' | 'finance1' | 'finance2';

// The reply is whatever the API sent; each test asserts the shape it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

describe('integration-real-postgres: payout destination hold', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `pdh${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
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
          email: `${key}-${suffix}@pdh.test`,
          passwordHash: 'x',
          fullName: `${key} ${suffix}`,
          roles: roles as never,
        },
      });
      for (const permission of grants) {
        await prisma.adminGrant.create({ data: { userId: user.id, permission } });
      }
      ids[key] = user.id;
      tokens[key] = jwt.sign(
        { sub: user.id, email: user.email, name: user.fullName, roles },
        { expiresIn: '30m' },
      );
    };
    await makeUser('owner', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('finance1', ['ADMIN'], [...ADMIN_PRESETS.FINANCE.grants]);
    await makeUser('finance2', ['ADMIN'], [...ADMIN_PRESETS.FINANCE.grants]);
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

  const payout = (currency: string, netMinor: number) =>
    prisma.payout.create({
      data: {
        organizationId: orgId,
        currency,
        netMinor,
        grossMinor: Math.max(netMinor, 0),
        status: 'PENDING',
      },
    });
  const statusOf = async (id: string) =>
    (await prisma.payout.findUniqueOrThrow({ where: { id } })).status;
  const pay = (id: string, actor: Actor = 'finance1') =>
    call(actor, 'POST', `/admin/payouts/${id}/pay`, { reference: 'UTR-HOLD' });
  const save = (accountNumber: string) =>
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
  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  it('holds a payout when the organizer has no bank account: 409, still PENDING, refusal audited', async () => {
    if (skip()) return;
    const p = await payout('INR', 10_000);
    const res = await pay(p.id);
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ hold: 'DESTINATION_NO_ACCOUNT' });
    expect(await statusOf(p.id)).toBe('PENDING');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: p.id, action: 'PAYOUT_PAID' },
    });
    expect(audit.metadata).toMatchObject({
      outcome: 'REFUSED',
      reasonCode: 'DESTINATION_NO_ACCOUNT',
    });
  });

  it('holds it while the freshly saved account waits for verification', async () => {
    if (skip()) return;
    expect((await save('501001234567')).status).toBe(201);
    const [p] = await prisma.payout.findMany({ where: { organizationId: orgId } });
    const res = await pay(p.id);
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ hold: 'DESTINATION_PENDING_VERIFICATION' });
    expect(await statusOf(p.id)).toBe('PENDING');
    // The message tells staff what to do and names no account detail.
    expect(res.body.message).toContain('Another staff member must verify');
    expect(JSON.stringify(res.body)).not.toContain('501001234567');
  });

  it('pays once an independent staff member has verified the account', async () => {
    if (skip()) return;
    const acc = await accountRow();
    expect(
      (
        await call('finance2', 'POST', `/admin/payouts/accounts/${acc.id}/verified`, {
          version: acc.version,
        })
      ).status,
    ).toBe(201);
    const [p] = await prisma.payout.findMany({ where: { organizationId: orgId } });
    const res = await pay(p.id);
    expect(res.status).toBe(201);
    expect(await statusOf(p.id)).toBe('PAID');
  });

  it('holds the next payout again as soon as the owner changes the account', async () => {
    if (skip()) return;
    const next = await payout('INR', 20_000);
    expect((await save('998877665544')).status).toBe(201);
    const res = await pay(next.id);
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ hold: 'DESTINATION_PENDING_VERIFICATION' });
    expect(await statusOf(next.id)).toBe('PENDING');

    // Turned down is a hold too, with its own reason.
    const acc = await accountRow();
    await call('finance2', 'POST', `/admin/payouts/accounts/${acc.id}/reject`, {
      reason: 'Name does not match',
      version: acc.version,
    });
    const rejected = await pay(next.id);
    expect(rejected.body.details).toMatchObject({ hold: 'DESTINATION_REJECTED' });

    // Saved again and verified by someone else: released.
    await save('998877665544');
    const again = await accountRow();
    await call('finance2', 'POST', `/admin/payouts/accounts/${again.id}/verified`, {
      version: again.version,
    });
    expect((await pay(next.id)).status).toBe(201);
    expect(await statusOf(next.id)).toBe('PAID');
  });

  it('an account in another currency does not release a payout', async () => {
    if (skip()) return;
    const usd = await payout('USD', 5_000);
    const res = await pay(usd.id);
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ hold: 'DESTINATION_NO_ACCOUNT' });
  });

  it('does not hold a payout that sends nothing to the organizer (a clawback)', async () => {
    if (skip()) return;
    const clawback = await payout('USD', -1_500);
    expect((await pay(clawback.id)).status).toBe(201);
    expect(await statusOf(clawback.id)).toBe('PAID');
  });

  it('a save that lands while a payment is being checked cannot slip past the check', async () => {
    if (skip()) return;
    // A verified account, a payout to pay, and a transaction that un-verifies the account (what
    // a save does) but has not committed yet. The payment must WAIT for it, then see the
    // pending account and be held. Without the FOR SHARE lock it would read the old verified
    // row and mark the payout PAID.
    const acc = await accountRow();
    const fresh = await payout('INR', 30_000);
    await save('112233445566');
    const saved = await accountRow();
    await call('finance2', 'POST', `/admin/payouts/accounts/${saved.id}/verified`, {
      version: saved.version,
    });
    expect(acc.id).toBe(saved.id);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const racing = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "OrganizerPayoutAccount" WHERE "id" = ${saved.id} FOR UPDATE`;
      await tx.organizerPayoutAccount.update({
        where: { id: saved.id },
        data: { verifiedAt: null, verifiedByUserId: null, version: { increment: 1 } },
      });
      await gate;
    });
    await new Promise((r) => setTimeout(r, 300));
    const paying = pay(fresh.id);
    await new Promise((r) => setTimeout(r, 500));
    release();
    await racing;
    const res = await paying;
    expect(res.status).toBe(409);
    expect(await statusOf(fresh.id)).toBe('PENDING');
  });
});
