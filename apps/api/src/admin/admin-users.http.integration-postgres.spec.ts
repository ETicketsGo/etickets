import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { AdminPermission } from '@eticketsgo/shared-types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';

/**
 * Suspending an account and ending its sessions, end to end, over real HTTP and Postgres.
 *
 * The claims that matter are about what the TARGET can do afterwards, so they are checked from
 * the target's side: its access token is refused on the very next request, its refresh token
 * cannot be rotated, and every one of its sessions is gone. The audit rows are read back from
 * the database, not from a mock, with actor, target, reason and client address.
 *
 * Staff tokens are signed directly (MFA is dormant here, as in admin-presets.integration-postgres)
 * and the target signs in with a real password, so its refresh tokens are real rows.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const PASSWORD = 'Copper-Harbour-7314!';

describe('integration-real-postgres: suspending an account and ending its sessions', () => {
  const url = loadEnvValue('DATABASE_URL');
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  const suffix = `usr-susp-${Date.now()}`;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as any;
    return { status: res.status, json };
  }

  const login = async (key: string) => {
    const r = await http('POST', '/auth/login', undefined, {
      email: `${key}-${suffix}@test.invalid`,
      password: PASSWORD,
    });
    expect(r.status).toBeLessThan(300);
    const data = r.json?.data ?? r.json;
    return { access: data.accessToken as string, refresh: data.refreshToken as string };
  };

  beforeAll(async () => {
    if (!url) {
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const jwt = new JwtService({
      secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'),
    });

    const hash = await bcrypt.hash(PASSWORD, 10);
    const make = async (key: string, roles: string[], grants: string[] = []) => {
      const user = await db!.user.create({
        data: {
          email: `${key}-${suffix}@test.invalid`,
          fullName: key,
          passwordHash: hash,
          roles,
        },
      });
      for (const permission of grants) {
        await db!.adminGrant.create({ data: { userId: user.id, permission } });
      }
      ids[key] = user.id;
      tokens[key] = jwt.sign(
        { sub: user.id, email: user.email, name: key, roles },
        { expiresIn: '30m' },
      );
    };
    await make('superadmin', ['ADMIN', 'SUPER_ADMIN']);
    await make('othersuper', ['ADMIN', 'SUPER_ADMIN']);
    await make('suspender', ['ADMIN'], [AdminPermission.USER_SUSPEND]);
    await make('bookingreader', ['ADMIN'], [AdminPermission.BOOKING_READ]);
    await make('customer', ['CUSTOMER']);
    await make('traveller', ['CUSTOMER']);
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const userIds = Object.values(ids);
      await db.auditLog.deleteMany({
        where: { OR: [{ actorUserId: { in: userIds } }, { entityId: { in: userIds } }] },
      });
      await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await db.adminGrant.deleteMany({ where: { userId: { in: userIds } } });
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

  maybe('needs USER_SUSPEND: BOOKING_READ alone is refused and changes nothing', async () => {
    const r = await http('POST', `/admin/users/${ids.customer}/suspend`, tokens.bookingreader, {
      reason: 'abuse',
    });
    expect(r.status).toBe(403);
    const row = await db!.user.findUnique({ where: { id: ids.customer } });
    expect(row.status).toBe('ACTIVE');
  });

  maybe(
    'suspends: the next request is refused, the refresh is refused, and it is audited',
    async () => {
      const session = await login('customer');
      expect((await http('GET', '/auth/me', session.access)).status).toBe(200);

      const r = await http('POST', `/admin/users/${ids.customer}/suspend`, tokens.suspender, {
        reason: 'Chargeback fraud, ticket 4411',
      });
      expect(r.status).toBe(201);

      // The very next request with the token it already holds.
      expect((await http('GET', '/auth/me', session.access)).status).toBe(401);
      // And it cannot quietly mint a new pair.
      const refresh = await http('POST', '/auth/refresh', undefined, {
        refreshToken: session.refresh,
      });
      expect(refresh.status).toBe(401);
      const live = await db!.refreshToken.count({
        where: { userId: ids.customer, revokedAt: null },
      });
      expect(live).toBe(0);

      const audit = await db!.auditLog.findFirst({
        where: { action: 'USER_SUSPENDED', entityId: ids.customer },
      });
      expect(audit).toMatchObject({ actorUserId: ids.suspender, entityType: 'User' });
      expect(audit.metadata).toMatchObject({ reason: 'Chargeback fraud, ticket 4411' });
      expect(audit.ip).toBeTruthy();
    },
  );

  maybe('reinstates: a fresh sign-in works again, and it is audited', async () => {
    const r = await http('POST', `/admin/users/${ids.customer}/reinstate`, tokens.suspender, {
      reason: 'Bank confirmed the card holder',
    });
    expect(r.status).toBe(201);
    const session = await login('customer');
    expect((await http('GET', '/auth/me', session.access)).status).toBe(200);
    const audit = await db!.auditLog.findFirst({
      where: { action: 'USER_REINSTATED', entityId: ids.customer },
    });
    expect(audit).toMatchObject({ actorUserId: ids.suspender });
  });

  maybe('revoke-sessions ends every session the account has', async () => {
    const a = await login('traveller');
    const b = await login('traveller');
    expect(
      await db!.refreshToken.count({ where: { userId: ids.traveller, revokedAt: null } }),
    ).toBeGreaterThanOrEqual(2);

    const r = await http(
      'POST',
      `/admin/users/${ids.traveller}/revoke-sessions`,
      tokens.suspender,
      {
        reason: 'Lost phone',
      },
    );
    expect(r.status).toBe(201);
    expect(r.json?.data?.sessionsRevoked ?? r.json?.sessionsRevoked).toBeGreaterThanOrEqual(2);

    for (const s of [a, b]) {
      const refresh = await http('POST', '/auth/refresh', undefined, { refreshToken: s.refresh });
      expect(refresh.status).toBe(401);
    }
    expect(
      await db!.refreshToken.count({ where: { userId: ids.traveller, revokedAt: null } }),
    ).toBe(0);
    // The account itself is untouched.
    expect((await db!.user.findUnique({ where: { id: ids.traveller } })).status).toBe('ACTIVE');
    const audit = await db!.auditLog.findFirst({
      where: { action: 'USER_SESSIONS_REVOKED', entityId: ids.traveller },
    });
    expect(audit).toMatchObject({ actorUserId: ids.suspender });
  });

  maybe('refuses to let anybody suspend themselves', async () => {
    const r = await http('POST', `/admin/users/${ids.suspender}/suspend`, tokens.suspender, {
      reason: 'test',
    });
    expect(r.status).toBe(403);
    expect((await db!.user.findUnique({ where: { id: ids.suspender } })).status).toBe('ACTIVE');
  });

  maybe('only a super admin can suspend a super admin', async () => {
    const refused = await http('POST', `/admin/users/${ids.othersuper}/suspend`, tokens.suspender, {
      reason: 'test',
    });
    expect(refused.status).toBe(403);
    expect((await db!.user.findUnique({ where: { id: ids.othersuper } })).status).toBe('ACTIVE');

    const allowed = await http(
      'POST',
      `/admin/users/${ids.othersuper}/suspend`,
      tokens.superadmin,
      {
        reason: 'Left the company',
      },
    );
    expect(allowed.status).toBe(201);
    expect((await db!.user.findUnique({ where: { id: ids.othersuper } })).status).toBe('SUSPENDED');
  });

  maybe('a suspend with no reason is refused', async () => {
    const r = await http('POST', `/admin/users/${ids.traveller}/suspend`, tokens.suspender, {});
    expect(r.status).toBe(400);
  });
});
