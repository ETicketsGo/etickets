import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ADMIN_PRESETS, AdminPermission } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A preset, assigned the way the Staff & duties page assigns it, grants exactly its
 * capabilities - and the account can then do exactly that, over real HTTP.
 *
 * The page applies a preset by sending its capability list to
 * `PUT /admin/staff/:userId/permissions`. So this does the same, as a super admin, for an
 * account per preset, then reads the result back three ways: the staff list, the account's own
 * `/auth/me`, and a probe per capability through the real guards. A probe refused with 403 is a
 * capability not held; anything else (200, or a 400/404 from a validation pipe or a missing
 * record, both of which run only AFTER the guards) is a capability held. Every write probe names
 * a record that does not exist or sends a body validation rejects, so nothing is changed.
 *
 * Fixtures are uniquely named and removed: the database is shared.
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

const MISSING = 'clmissingrecord000000000000';

/** One request per capability that only that capability opens. */
const PROBES: { capability: AdminPermission; method: string; path: string; body?: unknown }[] = [
  { capability: AdminPermission.BOOKING_READ, method: 'GET', path: '/admin/bookings' },
  { capability: AdminPermission.FINANCE_READ, method: 'GET', path: '/admin/reports/by-market' },
  { capability: AdminPermission.OPS_READ, method: 'GET', path: '/admin/outbox/health' },
  { capability: AdminPermission.REFUND_REVIEW, method: 'GET', path: '/admin/refunds' },
  { capability: AdminPermission.PAYOUT_MANAGE, method: 'GET', path: '/admin/settlements' },
  { capability: AdminPermission.PLATFORM_CONFIG_READ, method: 'GET', path: '/admin/fee-rules' },
  { capability: AdminPermission.EVENT_REVIEW, method: 'GET', path: '/admin/events' },
  { capability: AdminPermission.ORGANIZER_REVIEW, method: 'GET', path: '/admin/organizers' },
  { capability: AdminPermission.ADMIN_MANAGE, method: 'GET', path: '/admin/staff' },
  // Writes: a record that does not exist, or a body validation refuses. Nothing changes.
  {
    capability: AdminPermission.FINANCE_APPROVE,
    method: 'POST',
    path: `/admin/compensations/${MISSING}/approve`,
    body: {},
  },
  {
    capability: AdminPermission.FINANCE_RESOLVE,
    method: 'POST',
    path: `/admin/payments/finance/discrepancies/${MISSING}/ignore`,
    body: { reason: 'preset probe' },
  },
  {
    capability: AdminPermission.SUPPORT_MANAGE,
    method: 'PATCH',
    path: `/admin/support/${MISSING}`,
    body: { status: 'CLOSED' },
  },
  {
    capability: AdminPermission.OPS_EXECUTE,
    method: 'POST',
    path: `/admin/outbox/events/${MISSING}/retry`,
    body: {},
  },
  {
    capability: AdminPermission.PLATFORM_CONFIG,
    method: 'POST',
    path: '/admin/fee-rules',
    body: {},
  },
];

describe('integration-real-postgres: assigning a preset grants exactly its capabilities', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `prs${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
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
    const make = async (key: string, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key.toLowerCase().replace(/_/g, '-')}-${suffix}@prs.test`,
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
    await make('assigner', ['ADMIN', 'SUPER_ADMIN']);
    for (const key of Object.keys(ADMIN_PRESETS)) await make(key, ['ADMIN']);
    // An account assigned the OLD finance bundle before approval. Editing the preset must not
    // change it: presets apply at assignment time only.
    await make(
      'legacyFinance',
      ['ADMIN'],
      [
        AdminPermission.BOOKING_READ,
        AdminPermission.FINANCE_READ,
        AdminPermission.REFUND_REVIEW,
        AdminPermission.REFUND_APPROVE,
        AdminPermission.PAYOUT_MANAGE,
      ],
    );
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ actorUserId: { in: userIds } }, { entityId: { in: userIds } }],
        },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  async function call(actor: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
  }

  it.each(Object.keys(ADMIN_PRESETS))(
    '%s: assigned through Staff & duties, the account holds exactly the bundle and can do exactly that',
    async (key) => {
      if (!app) return;
      const grants = [...ADMIN_PRESETS[key].grants];

      // Assign, as the page does: the preset's list, sent whole.
      const put = await call('assigner', 'PUT', `/admin/staff/${ids[key]}/permissions`, {
        permissions: grants,
        note: 'preset test',
      });
      expect(put.status).toBe(200);

      // What the database holds.
      const rows = await prisma.adminGrant.findMany({ where: { userId: ids[key] } });
      expect(rows.map((r) => r.permission).sort()).toEqual([...grants].sort());

      // What the staff list says.
      const list = await call('assigner', 'GET', '/admin/staff');
      const entry = (list.body as { id: string; permissions: string[] }[]).find(
        (s) => s.id === ids[key],
      );
      expect([...(entry?.permissions ?? [])].sort()).toEqual([...grants].sort());

      // What the account is told it may do.
      const me = await call(key, 'GET', '/auth/me');
      expect(me.status).toBe(200);
      expect(
        [...((me.body as { adminPermissions: string[] }).adminPermissions ?? [])].sort(),
      ).toEqual([...grants].sort());

      // What the guards actually let it do.
      for (const probe of PROBES) {
        const res = await call(key, probe.method, probe.path, probe.body);
        expect({ preset: key, probe: probe.capability, refused: res.status === 403 }).toEqual({
          preset: key,
          probe: probe.capability,
          refused: !grants.includes(probe.capability),
        });
        expect(res.status).not.toBe(401);
      }
    },
  );

  it('leaves an account given the old FINANCE bundle exactly as it was', async () => {
    if (!app) return;
    const rows = await prisma.adminGrant.findMany({ where: { userId: ids.legacyFinance } });
    expect(rows.map((r) => r.permission).sort()).toEqual(
      [
        AdminPermission.BOOKING_READ,
        AdminPermission.FINANCE_READ,
        AdminPermission.PAYOUT_MANAGE,
        AdminPermission.REFUND_APPROVE,
        AdminPermission.REFUND_REVIEW,
      ].sort(),
    );
    // And it still cannot do what the new bundle adds.
    for (const capability of [
      AdminPermission.FINANCE_APPROVE,
      AdminPermission.FINANCE_RESOLVE,
      AdminPermission.PLATFORM_CONFIG_READ,
    ]) {
      const probe = PROBES.find((p) => p.capability === capability)!;
      expect((await call('legacyFinance', probe.method, probe.path, probe.body)).status).toBe(403);
    }
  });
});
