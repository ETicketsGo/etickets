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
 * A saved bank account reaches the staff who can verify it (B1).
 *
 * ── THE INCIDENT ───────────────────────────────────────────────────────────────────
 * On production an organizer owner - who is also the super admin - saved a bank account. It sat
 * at PENDING_VERIFICATION, the admin dashboard said nothing was waiting, nobody was notified, and
 * when the owner tried to verify it themselves maker-checker (correctly) refused SAME_PERSON.
 *
 * ── WHAT THESE PROVE, THROUGH THE WHOLE APP ON A REAL DATABASE ─────────────────────
 *  1. A save queues PAYOUT_ACCOUNT_AWAITING_VERIFICATION for staff holding PAYOUT_MANAGE AND
 *     BANK_VERIFY - and not for support, a payer without BANK_VERIFY, the person who saved, or a
 *     member of the organization. The payload is masked.
 *  2. The admin list the dashboard counts from has the account as waiting, and tells each viewer
 *     whether maker-checker will refuse THEM (SAME_PERSON / ORGANIZATION_MEMBER) before they try.
 *  3. Staff without PAYOUT_MANAGE cannot read the list at all.
 *  4. Maker-checker is unchanged: the saver is still refused; an independent verifier succeeds,
 *     and the account leaves the queue.
 *
 * Fixtures carry a unique suffix and are removed afterwards: the database may be shared.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

type Actor = 'ownerStaff' | 'verifier' | 'payer' | 'support' | 'memberStaff';

const NUMBER = '30112345674567';
const TYPE = 'PAYOUT_ACCOUNT_AWAITING_VERIFICATION';

describe('integration-real-postgres: a saved bank account reaches its verifiers', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `bvq${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<Actor, string>;
  const tokens = {} as Record<Actor, string>;
  let org = '';
  let accountId = '';
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
    const makeUser = async (key: Actor, roles: string[], grants: readonly string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key.toLowerCase()}-${suffix}@bvq.test`,
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
    // The production shape: the organization's owner is also the super admin.
    await makeUser('ownerStaff', ['SUPER_ADMIN', 'ORGANIZER_OWNER']);
    await makeUser('verifier', ['ADMIN'], ADMIN_PRESETS.FINANCE_VERIFIER.grants);
    await makeUser('payer', ['ADMIN'], ADMIN_PRESETS.FINANCE_PAYER.grants);
    await makeUser('support', ['ADMIN'], ADMIN_PRESETS.SUPPORT.grants);
    // Holds every verifier capability but works inside the organization.
    await makeUser(
      'memberStaff',
      ['ADMIN', 'ORGANIZER_MANAGER'],
      ADMIN_PRESETS.FINANCE_VERIFIER.grants,
    );

    org = (
      await prisma.organization.create({
        data: { name: `Walk Org ${suffix}`, slug: `walk-org-${suffix}`, legalName: 'Walk Legal' },
      })
    ).id;
    await prisma.organizationMember.create({
      data: {
        organizationId: org,
        userId: ids.ownerStaff,
        role: 'ORGANIZER_OWNER',
        status: 'ACTIVE',
      },
    });
    await prisma.organizationMember.create({
      data: {
        organizationId: org,
        userId: ids.memberStaff,
        role: 'ORGANIZER_MANAGER',
        status: 'ACTIVE',
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorUserId: { in: userIds } }, { organizationId: org || undefined }] },
      });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      if (org) await prisma.organization.deleteMany({ where: { id: org } });
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
    return { status: res.status, body: parsed as never };
  }

  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  /*
    Notifications this spec causes are left PENDING (no worker runs here). Another suite's
    `dispatchDue` sweeps EVERY due row on the shared CI database, and one that picks up ours just
    before afterAll deletes it fails with "record to update not found". Cancelling them as soon as
    they are asserted takes them out of every sweep.
  */
  const quiet = () =>
    prisma.notification.updateMany({
      where: { userId: { in: Object.values(ids) }, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });

  /** This organization's rows in the admin list, as `actor` sees them. */
  async function listed(actor: Actor) {
    const res = await call(actor, 'GET', '/admin/payouts/accounts');
    expect(res.status).toBe(200);
    return (
      res.body as {
        organization: { id: string };
        status: string;
        independenceBlock: string | null;
      }[]
    ).filter((r) => r.organization.id === org);
  }

  it('a save queues a masked notice for verifiers only - not support, a payer, the saver or a member', async () => {
    if (skip()) return;
    const res = await call('ownerStaff', 'POST', '/payouts/accounts', {
      organizationId: org,
      currency: 'INR',
      holderName: 'Walk Legal',
      bankName: 'State Bank of India',
      bankCode: 'SBIN0001234',
      accountNumber: NUMBER,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING_VERIFICATION', version: 1 });
    accountId = res.body.id;

    const rows = await prisma.notification.findMany({
      where: { type: TYPE, userId: { in: Object.values(ids) } },
    });
    expect([...new Set(rows.map((r) => r.userId))]).toEqual([ids.verifier]);
    // In the inbox and by email, as the other approval queues are.
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'in_app']);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      accountId,
      organizationId: org,
      organizationName: `Walk Org ${suffix}`,
      currency: 'INR',
      bankName: 'State Bank of India',
      accountLast4: '4567',
      version: 1,
      savedByEmail: `ownerstaff-${suffix}@bvq.test`,
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(NUMBER);
    expect(text).not.toMatch(/cipher/i);
    await quiet();
  });

  it('the dashboard list counts it as waiting, and tells each viewer whether they may decide', async () => {
    if (skip()) return;
    const asVerifier = await listed('verifier');
    expect(asVerifier.filter((r) => r.status === 'PENDING_VERIFICATION')).toHaveLength(1);
    expect(asVerifier[0].independenceBlock).toBeNull();
    expect((await listed('ownerStaff'))[0].independenceBlock).toBe('SAME_PERSON');
    expect((await listed('memberStaff'))[0].independenceBlock).toBe('ORGANIZATION_MEMBER');
    expect(JSON.stringify(asVerifier)).not.toContain(NUMBER);
  });

  it('staff without PAYOUT_MANAGE cannot read the list the queue counts', async () => {
    if (skip()) return;
    expect((await call('support', 'GET', '/admin/payouts/accounts')).status).toBe(403);
  });

  it('maker-checker still refuses the saver; an independent verifier clears the queue', async () => {
    if (skip()) return;
    const self = await call('ownerStaff', 'POST', `/admin/payouts/accounts/${accountId}/verified`, {
      version: 1,
    });
    expect(self.status).toBe(403);
    // A payer holds PAYOUT_MANAGE but not BANK_VERIFY.
    expect(
      (await call('payer', 'POST', `/admin/payouts/accounts/${accountId}/verified`, { version: 1 }))
        .status,
    ).toBe(403);
    const ok = await call('verifier', 'POST', `/admin/payouts/accounts/${accountId}/verified`, {
      version: 1,
    });
    expect(ok.status).toBe(201);
    const after = await listed('verifier');
    expect(after.filter((r) => r.status === 'PENDING_VERIFICATION')).toHaveLength(0);
    expect(after[0].independenceBlock).toBeNull();
    await quiet();
  });
});
