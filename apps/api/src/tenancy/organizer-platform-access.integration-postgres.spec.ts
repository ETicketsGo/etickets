import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ADMIN_PRESETS, AdminPermission } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  PLATFORM_ORGANIZER_ACCESS_ALLOWED,
  PLATFORM_ORGANIZER_ACCESS_DENIED,
} from './org-access.service';

/**
 * Platform staff and organizer routes, through the WHOLE application.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * `OrgAccessService.assertMember` returned early for any platform ADMIN, with no membership
 * and no capability. A back-office account granted nothing at all could save any organizer's
 * payout bank account, raise their payouts, rewrite their legal identity and edit or delete
 * their events.
 *
 * ── WHY THE WHOLE APP AND A REAL DATABASE ──────────────────────────────────────────
 * The decision is spread across four places - the guards (JwtAuthGuard reading roles from the
 * DATABASE, OrganizerOnlyGuard, RolesGuard), and the tenant check deep in each service - and
 * the defect lived in the seam between them. So the requests here are real HTTP with real
 * signed tokens, through the real module graph, and "nothing was written" is read back from
 * Postgres rather than inferred from a mock not being called.
 *
 * Fixtures are created with a unique suffix and removed afterwards: the database is shared.
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

type ActorKey =
  | 'zeroAdmin'
  | 'readOnlyAdmin'
  | 'financeAdmin'
  | 'supportAdmin'
  | 'moderator'
  | 'superAdmin'
  | 'ownerA'
  | 'managerA'
  | 'checkinA'
  | 'ownerB';

/** Every platform staff shape the task names. None is a member of either organization. */
const STAFF: Record<
  Extract<
    ActorKey,
    'zeroAdmin' | 'readOnlyAdmin' | 'financeAdmin' | 'supportAdmin' | 'moderator' | 'superAdmin'
  >,
  { roles: string[]; grants: string[] }
> = {
  /** The account the defect was about: ADMIN, granted nothing. */
  zeroAdmin: { roles: ['ADMIN'], grants: [] },
  /** Every READ capability there is. */
  readOnlyAdmin: {
    roles: ['ADMIN'],
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.ORGANIZER_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.OPS_READ,
      AdminPermission.PLATFORM_CONFIG_READ,
    ],
  },
  /** The FINANCE preset, exactly: PAYOUT_MANAGE and REFUND_APPROVE among it. */
  financeAdmin: { roles: ['ADMIN'], grants: [...ADMIN_PRESETS.FINANCE.grants] },
  supportAdmin: { roles: ['ADMIN'], grants: [...ADMIN_PRESETS.SUPPORT.grants] },
  moderator: { roles: ['ADMIN'], grants: [...ADMIN_PRESETS.MODERATOR.grants] },
  /** Holds every capability by role, with no grant rows. */
  superAdmin: { roles: ['ADMIN', 'SUPER_ADMIN'], grants: [] },
};
const STAFF_KEYS = Object.keys(STAFF) as (keyof typeof STAFF)[];

describe('integration-real-postgres: platform staff on organizer routes', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `opa${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<ActorKey, string>;
  const tokens = {} as Record<ActorKey, string>;
  let orgA = '';
  let orgB = '';
  let venueA = '';
  let eventA = '';
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
      // Hundreds of requests from one address; the throttle is not what is under test.
      THROTTLE_LIMIT: '100000',
      // So an owner's allowed save really saves, rather than stopping at "no key here".
      PAYOUT_BANK_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    if (!process.env.JWT_ACCESS_SECRET) {
      process.env.JWT_ACCESS_SECRET = loadEnvValue('JWT_ACCESS_SECRET');
    }

    // Required, not imported: the config module reads the environment when app.module loads.
    const { AppModule } = require('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    const makeUser = async (key: ActorKey, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key.toLowerCase()}-${suffix}@opa.test`,
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
    for (const key of STAFF_KEYS) await makeUser(key, STAFF[key].roles, STAFF[key].grants);
    await makeUser('ownerA', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('managerA', ['CUSTOMER', 'ORGANIZER_MANAGER']);
    await makeUser('checkinA', ['CUSTOMER', 'CHECKIN_STAFF']);
    await makeUser('ownerB', ['CUSTOMER', 'ORGANIZER_OWNER']);

    const a = await prisma.organization.create({
      data: { name: `Org A ${suffix}`, slug: `org-a-${suffix}`, legalName: 'Org A Legal' },
    });
    const b = await prisma.organization.create({
      data: { name: `Org B ${suffix}`, slug: `org-b-${suffix}` },
    });
    orgA = a.id;
    orgB = b.id;
    const members: [ActorKey, string, string][] = [
      ['ownerA', orgA, 'ORGANIZER_OWNER'],
      ['managerA', orgA, 'ORGANIZER_MANAGER'],
      ['checkinA', orgA, 'CHECKIN_STAFF'],
      ['ownerB', orgB, 'ORGANIZER_OWNER'],
    ];
    for (const [key, organizationId, role] of members) {
      await prisma.organizationMember.create({
        data: { organizationId, userId: ids[key], role: role as never, status: 'ACTIVE' },
      });
    }
    const venue = await prisma.venue.create({
      data: { organizationId: orgA, name: `Hall ${suffix}`, city: 'Hyderabad' },
    });
    venueA = venue.id;
    eventA = (await makeEvent('a')).id;
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { actorUserId: { in: userIds } },
            { organizationId: { in: [orgA, orgB].filter(Boolean) } },
          ],
        },
      });
      await prisma.event.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  async function makeEvent(tag: string) {
    return prisma.event.create({
      data: {
        organizationId: orgA,
        venueId: venueA,
        title: `Event ${tag} ${suffix}`,
        slug: `ev-${tag}-${suffix}`,
        category: 'Music',
      },
    });
  }

  async function call(
    actor: ActorKey,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  }

  const auditRows = (actor: ActorKey, action: string) =>
    prisma.auditLog.findMany({ where: { actorUserId: ids[actor], action } });

  const skipIfUnavailable = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  // ── Money and identity: no platform staff, whatever they hold ─────────────────────────

  const bankBody = () => ({
    organizationId: orgA,
    currency: 'INR',
    holderName: 'Mallory',
    bankName: 'Attacker Bank',
    bankCode: 'ATKR0000001',
    accountNumber: '123456789012',
  });

  it.each(STAFF_KEYS)(
    '%s cannot save a payout bank account for an organization: 403, nothing written, refusal audited',
    async (actor) => {
      if (skipIfUnavailable()) return;
      const res = await call(actor, 'POST', '/payouts/accounts', bankBody());
      expect(res.status).toBe(403);
      expect(await prisma.organizerPayoutAccount.count({ where: { organizationId: orgA } })).toBe(
        0,
      );
      const denied = await auditRows(actor, PLATFORM_ORGANIZER_ACCESS_DENIED);
      expect(denied).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organizationId: orgA,
            metadata: expect.objectContaining({
              operation: 'payout.account.save',
              result: 'DENIED',
            }),
          }),
        ]),
      );
      // Refused at the door, so no handler ran and no PAYOUT_ACCOUNT_SAVED was ever written.
      expect(
        await prisma.auditLog.count({
          where: { organizationId: orgA, action: 'PAYOUT_ACCOUNT_SAVED' },
        }),
      ).toBe(0);
    },
  );

  it.each(STAFF_KEYS)('%s cannot raise a payout for an organization', async (actor) => {
    if (skipIfUnavailable()) return;
    const res = await call(actor, 'POST', '/payouts/generate', { organizationId: orgA });
    expect(res.status).toBe(403);
    expect(await prisma.payout.count({ where: { organizationId: orgA } })).toBe(0);
  });

  it.each(STAFF_KEYS)('%s cannot record cash at the counter', async (actor) => {
    if (skipIfUnavailable()) return;
    // A booking id that does not exist: a handler that ran would answer 404. 403 is the door.
    const res = await call(actor, 'POST', `/payments/ck${suffix}nobooking/collect-cash`);
    expect(res.status).toBe(403);
  });

  it.each(STAFF_KEYS)(
    '%s cannot rewrite legal identity through the organizer API',
    async (actor) => {
      if (skipIfUnavailable()) return;
      const res = await call(actor, 'PATCH', `/organizations/${orgA}/legal-identity`, {
        legalName: 'Hijacked Ltd',
      });
      expect(res.status).toBe(403);
      const org = await prisma.organization.findUnique({ where: { id: orgA } });
      expect(org?.legalName).toBe('Org A Legal');
    },
  );

  it.each(STAFF_KEYS)('%s cannot link a Razorpay payout account', async (actor) => {
    if (skipIfUnavailable()) return;
    const res = await call(actor, 'POST', `/organizers/${orgA}/payments/razorpay/account`, {
      linkedAccountId: 'acc_ATTACKER0000001',
    });
    expect(res.status).toBe(403);
    expect(await prisma.organizerPaymentAccount.count({ where: { organizationId: orgA } })).toBe(0);
  });

  it.each(STAFF_KEYS)(
    '%s cannot read the payout bank accounts on the organizer API',
    async (actor) => {
      if (skipIfUnavailable()) return;
      const res = await call(actor, 'GET', `/payouts/accounts?organizationId=${orgA}`);
      expect(res.status).toBe(403);
    },
  );

  // ── Organizer content: no unlisted staff path, super admin included ──────────────────

  it.each(STAFF_KEYS)('%s cannot edit an organization event', async (actor) => {
    if (skipIfUnavailable()) return;
    const res = await call(actor, 'PATCH', `/events/${eventA}`, { title: 'Defaced' });
    expect(res.status).toBe(403);
    const ev = await prisma.event.findUnique({ where: { id: eventA } });
    expect(ev?.title).toBe(`Event a ${suffix}`);
  });

  it.each(STAFF_KEYS)('%s cannot invite a team member', async (actor) => {
    if (skipIfUnavailable()) return;
    const res = await call(actor, 'POST', `/organizations/${orgA}/members`, {
      email: `planted.${suffix}@gmail.com`,
      role: 'ORGANIZER_OWNER',
    });
    expect(res.status).toBe(403);
    expect(
      await prisma.organizationMember.count({ where: { organizationId: orgA, status: 'INVITED' } }),
    ).toBe(0);
  });

  it.each(STAFF_KEYS)(
    '%s does not see organizations in the organizer console list',
    async (actor) => {
      if (skipIfUnavailable()) return;
      const res = await call(actor, 'GET', '/organizations');
      expect(res.status).toBe(200);
      const listed = (res.body as unknown as { id: string }[]).map((o) => o.id);
      expect(listed).not.toContain(orgA);
      expect(listed).not.toContain(orgB);
    },
  );

  // ── The two documented staff operations ──────────────────────────────────────────────

  it('reading an organization needs ORGANIZER_READ, and each staff read is audited', async () => {
    if (skipIfUnavailable()) return;
    const expected: Record<keyof typeof STAFF, number> = {
      zeroAdmin: 403,
      readOnlyAdmin: 200,
      financeAdmin: 403, // the FINANCE preset holds no ORGANIZER_READ
      supportAdmin: 200,
      moderator: 200,
      superAdmin: 200,
    };
    for (const actor of STAFF_KEYS) {
      const res = await call(actor, 'GET', `/organizations/${orgA}`);
      expect({ actor, status: res.status }).toEqual({ actor, status: expected[actor] });
      const action =
        expected[actor] === 200
          ? PLATFORM_ORGANIZER_ACCESS_ALLOWED
          : PLATFORM_ORGANIZER_ACCESS_DENIED;
      const rows = (await auditRows(actor, action)).filter(
        (r) => (r.metadata as { operation?: string }).operation === 'organization.read',
      );
      // One row per read, naming the TARGET organization and the request it belongs to.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.organizationId === orgA && !!r.correlationId)).toBe(true);
    }
  });

  it('deleting an event needs EVENT_REVIEW: refused without it, allowed and audited with it', async () => {
    if (skipIfUnavailable()) return;
    const doomed = await makeEvent('del');
    for (const actor of ['zeroAdmin', 'readOnlyAdmin', 'financeAdmin', 'supportAdmin'] as const) {
      const res = await call(actor, 'DELETE', `/events/${doomed.id}`);
      expect({ actor, status: res.status }).toEqual({ actor, status: 403 });
      expect(await prisma.event.count({ where: { id: doomed.id } })).toBe(1);
    }
    const res = await call('moderator', 'DELETE', `/events/${doomed.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.event.count({ where: { id: doomed.id } })).toBe(0);
    const allowed = await auditRows('moderator', PLATFORM_ORGANIZER_ACCESS_ALLOWED);
    expect(allowed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: orgA,
          metadata: expect.objectContaining({ operation: 'event.delete', result: 'ALLOWED' }),
        }),
      ]),
    );
  });

  // ── Organizer members: exactly as before ────────────────────────────────────────────

  it('the owner saves the bank account, edits legal identity and an event', async () => {
    if (skipIfUnavailable()) return;
    expect((await call('ownerA', 'POST', '/payouts/accounts', bankBody())).status).toBe(201);
    expect(await prisma.organizerPayoutAccount.count({ where: { organizationId: orgA } })).toBe(1);
    expect(
      (
        await call('ownerA', 'PATCH', `/organizations/${orgA}/legal-identity`, {
          legalName: 'Org A Legal',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('ownerA', 'PATCH', `/events/${eventA}`, { title: `Event a ${suffix}` })).status,
    ).toBe(200);
    expect((await call('ownerA', 'GET', `/payouts/accounts?organizationId=${orgA}`)).status).toBe(
      200,
    );
    // Past the door: a missing booking is the handler's 404, not a refusal.
    expect(
      (await call('ownerA', 'POST', `/payments/ck${suffix}nobooking/collect-cash`)).status,
    ).toBe(404);
    // Members are not audited as platform access.
    expect(await auditRows('ownerA', PLATFORM_ORGANIZER_ACCESS_ALLOWED)).toHaveLength(0);
    expect(await auditRows('ownerA', PLATFORM_ORGANIZER_ACCESS_DENIED)).toHaveLength(0);
  });

  it('the manager edits events and reads payouts, but not the bank account or legal identity', async () => {
    if (skipIfUnavailable()) return;
    expect(
      (await call('managerA', 'PATCH', `/events/${eventA}`, { title: `Event a ${suffix}` })).status,
    ).toBe(200);
    expect((await call('managerA', 'GET', `/payouts/accounts?organizationId=${orgA}`)).status).toBe(
      200,
    );
    expect((await call('managerA', 'POST', '/payouts/accounts', bankBody())).status).toBe(403);
    expect(
      (await call('managerA', 'PATCH', `/organizations/${orgA}/legal-identity`, { legalName: 'X' }))
        .status,
    ).toBe(403);
  });

  it('check-in staff read their organization but change nothing above the door', async () => {
    if (skipIfUnavailable()) return;
    expect((await call('checkinA', 'GET', `/organizations/${orgA}`)).status).toBe(200);
    expect(
      (await call('checkinA', 'PATCH', `/events/${eventA}`, { title: 'Defaced' })).status,
    ).toBe(403);
    expect((await call('checkinA', 'GET', `/payouts/accounts?organizationId=${orgA}`)).status).toBe(
      403,
    );
    expect(
      (await call('checkinA', 'POST', '/payouts/generate', { organizationId: orgA })).status,
    ).toBe(403);
    // Door staff record cash: past the door, the missing booking is a 404.
    expect(
      (await call('checkinA', 'POST', `/payments/ck${suffix}nobooking/collect-cash`)).status,
    ).toBe(404);
  });

  it('an owner of ANOTHER organization gets nothing of this one, even naming it', async () => {
    if (skipIfUnavailable()) return;
    expect((await call('ownerB', 'GET', `/organizations/${orgA}`)).status).toBe(403);
    expect((await call('ownerB', 'PATCH', `/events/${eventA}`, { title: 'Defaced' })).status).toBe(
      403,
    );
    expect((await call('ownerB', 'POST', '/payouts/accounts', bankBody())).status).toBe(403);
    expect(
      (await call('ownerB', 'PATCH', `/organizations/${orgA}/legal-identity`, { legalName: 'X' }))
        .status,
    ).toBe(403);
    // Its OWN organization id with ANOTHER organization's event: the event's organization
    // decides, not the one the client names.
    expect(
      (await call('ownerB', 'GET', `/payouts/finance?organizationId=${orgB}&eventId=${eventA}`))
        .status,
    ).not.toBe(200);
  });
});
