import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';

/**
 * integration-real-postgres, whole app over HTTP: a session that has gone stale is told so,
 * instead of being quietly carried on as somebody else.
 *
 * Two defects found walking QA (0da7c64):
 *
 *  1. POST /support is public with OptionalJwtAuthGuard. An EXPIRED access token was treated as
 *     no token at all, so an organizer's "Ask ETicketsGo to change this" (which sends no email,
 *     because a signed-in person's email is known) was refused with 400 "An email address is
 *     required so we can reply." after the page had been open fifteen minutes. The client
 *     refreshes on 401, never on 400. Now: present-but-bad token -> 401; no token -> anonymous.
 *
 *  2. Removing a member's last seat revokes their refresh tokens ("signed out everywhere"), but
 *     the access token they held kept working as a customer until it expired, so their open tab
 *     landed on "Set up your organization". Now that token is refused with ACCESS_REMOVED and
 *     names the organization; a session they start again afterwards works.
 *
 * Skips (never fabricates a pass) without a database.
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

describe('integration-real-postgres: stale sessions are refused, not downgraded', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let secret = '';
  let available = false;

  const suffix = `sess-fresh-${Date.now()}`;
  const orgName = `Walk Freshness Org ${suffix}`;
  let orgId = '';
  let ownerToken = '';
  const ownerEmail = `owner-${suffix}@test.invalid`;
  const staffEmail = `staff-${suffix}@test.invalid`;
  let ownerId = '';

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
    return { status: res.status, json };
  }

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    const data = r.json.data ?? r.json;
    return { access: data.accessToken as string, refresh: data.refreshToken as string };
  };

  /** A correctly signed token whose lifetime ended a minute ago - what a long-open page holds. */
  const expiredTokenFor = (userId: string, email: string) =>
    new JwtService({ secret }).sign(
      {
        sub: userId,
        email,
        name: 'Owner',
        roles: ['ORGANIZER_OWNER'],
        iat: Math.floor(Date.now() / 1000) - 1000,
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      { secret },
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
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    secret = app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET');

    const hash = await bcrypt.hash(PASSWORD, 10);
    const owner = await db!.user.create({
      data: { email: ownerEmail, fullName: 'Owner', passwordHash: hash, roles: ['CUSTOMER'] },
    });
    ownerId = owner.id;
    const org = await db!.organization.create({
      data: { name: orgName, slug: `walk-fresh-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    ownerToken = (await login(ownerEmail)).access;
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      await db.feedback.deleteMany({
        where: { OR: [{ userId: { in: ids } }, { email: { contains: suffix } }] },
      });
      await db.accountInvitation.deleteMany({ where: { userId: { in: ids } } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: orgId }, { actorUserId: { in: ids } }] },
      });
      await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
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

  const contact = { kind: 'CONTACT', subject: 'Walk freshness', message: 'Please change this.' };

  maybe('an expired token on POST /support is refused with 401, not judged anonymous', async () => {
    const r = await http('POST', '/support', expiredTokenFor(ownerId, ownerEmail), contact);
    // Before the fix this was 400 VALIDATION_FAILED "An email address is required so we can reply."
    expect(r.status).toBe(401);
  });

  maybe('a garbage bearer token is refused with 401 too', async () => {
    const r = await http('POST', '/support', 'not-a-jwt', contact);
    expect(r.status).toBe(401);
  });

  maybe('a valid token sends without an email and is filed under the account', async () => {
    const r = await http('POST', '/support', ownerToken, contact);
    expect(r.status).toBe(201);
    const id = (r.json.data ?? r.json).id as string;
    const row = await db!.feedback.findUnique({ where: { id } });
    expect(row?.userId).toBe(ownerId);
    expect(row?.email).toBe(ownerEmail);
  });

  maybe('with no token at all a visitor can still write in with an email', async () => {
    const r = await http('POST', '/support', undefined, {
      ...contact,
      email: `visitor-${suffix}@test.invalid`,
    });
    expect(r.status).toBe(201);
  });

  maybe('with no token and no email the old validation still answers', async () => {
    const r = await http('POST', '/support', undefined, contact);
    expect(r.status).toBe(400);
    expect(r.json.error?.code ?? r.json.code).toBe('VALIDATION_FAILED');
  });

  maybe(
    'a removed member: their held access token is refused with ACCESS_REMOVED naming the org',
    async () => {
      const hash = await bcrypt.hash(PASSWORD, 10);
      const staff = await db!.user.create({
        data: { email: staffEmail, fullName: 'Staff', passwordHash: hash, roles: ['CUSTOMER'] },
      });
      const seat = await db!.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: staff.id,
          role: 'ORGANIZER_MANAGER',
          status: 'ACTIVE',
        },
      });
      const held = await login(staffEmail);
      expect((await http('GET', `/organizations/${orgId}`, held.access)).status).toBe(200);

      // iat is whole seconds; step past the second the token was minted in.
      await new Promise((r) => setTimeout(r, 1100));
      const removed = await http(
        'DELETE',
        `/organizations/${orgId}/members/${seat.id}`,
        ownerToken,
      );
      expect(removed.status).toBeLessThan(300);
      expect((removed.json.data ?? removed.json).revoked.signedOut).toBe(true);

      // Before the fix: 200 with roles [CUSTOMER] - the console then showed the setup page.
      const me = await http('GET', '/auth/me', held.access);
      expect(me.status).toBe(401);
      const err = me.json.error ?? me.json;
      expect(err.code).toBe('ACCESS_REMOVED');
      expect(err.message).toBe(`You no longer have access to ${orgName}.`);

      // The refresh token went with the removal, so the client cannot quietly continue.
      const refresh = await http('POST', '/auth/refresh', undefined, {
        refreshToken: held.refresh,
      });
      expect(refresh.status).toBe(401);

      // Signing in again starts a NEW session, which is not refused: the account itself is fine.
      await new Promise((r) => setTimeout(r, 1100));
      const again = await login(staffEmail);
      const me2 = await http('GET', '/auth/me', again.access);
      expect(me2.status).toBe(200);
      expect((me2.json.data ?? me2.json).roles).not.toContain('ORGANIZER_MANAGER');
    },
  );

  maybe('a member who never had a seat removed is untouched (no false refusals)', async () => {
    const me = await http('GET', '/auth/me', ownerToken);
    expect(me.status).toBe(200);
  });
});
