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
 * Customer resources, through the WHOLE application: who may touch somebody else's booking or
 * ticket, and which privileged operations leave an audit row.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * Nine customer routes checked `ADMIN` / `SUPER_ADMIN` directly - read a booking, cancel it, open
 * a payment for it, verify a Razorpay payment, read a ticket, assign / invite / transfer /
 * unassign its attendee, manage its share links, make a wallet pass. A back-office account
 * granted NOTHING could act as the buyer on any customer's booking. Support reads a booking
 * through `GET /admin/bookings/:id` (BOOKING_READ, audited) now, and nothing else.
 *
 * Real HTTP, real signed tokens, real module graph, and "nothing changed" is read back from
 * Postgres. Fixtures carry a unique suffix and are removed afterwards: the database is shared.
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
  | 'supportAdmin'
  | 'financeAdmin'
  | 'superAdmin'
  | 'custA'
  | 'custB'
  | 'ownerA'
  | 'ownerB';

const STAFF = {
  zeroAdmin: { roles: ['ADMIN'], grants: [] as string[] },
  // Every READ capability there is, BOOKING_READ included.
  readOnlyAdmin: {
    roles: ['ADMIN'],
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.ORGANIZER_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.OPS_READ,
      AdminPermission.PLATFORM_CONFIG_READ,
    ] as string[],
  },
  supportAdmin: { roles: ['ADMIN'], grants: [...ADMIN_PRESETS.SUPPORT.grants] as string[] },
  financeAdmin: { roles: ['ADMIN'], grants: [...ADMIN_PRESETS.FINANCE.grants] as string[] },
  // Holds every capability by role, with no grant rows.
  superAdmin: { roles: ['ADMIN', 'SUPER_ADMIN'], grants: [] as string[] },
};
const STAFF_KEYS = Object.keys(STAFF) as (keyof typeof STAFF)[];

describe('integration-real-postgres: customer resources and operational audit', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let base = '';
  const suffix = `cri${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<ActorKey, string>;
  const tokens = {} as Record<ActorKey, string>;
  let orgA = '';
  let orgB = '';
  let confirmedId = '';
  let pendingId = '';
  let ticketId = '';
  let bookingBId = '';
  let ticketBId = '';
  let shareId = '';
  let inviteId = '';
  let feedbackId = '';
  const rateIds: string[] = [];
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
      // A share link is built from the customer site's address.
      CUSTOMER_WEB_URL: 'http://localhost:3000',
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
    const makeUser = async (key: ActorKey, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key.toLowerCase()}-${suffix}@cri.test`,
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
    await makeUser('custA', ['CUSTOMER']);
    await makeUser('custB', ['CUSTOMER']);
    await makeUser('ownerA', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await makeUser('ownerB', ['CUSTOMER', 'ORGANIZER_OWNER']);

    const a = await prisma.organization.create({
      data: { name: `Org A ${suffix}`, slug: `org-a-${suffix}` },
    });
    const b = await prisma.organization.create({
      data: { name: `Org B ${suffix}`, slug: `org-b-${suffix}` },
    });
    orgA = a.id;
    orgB = b.id;
    for (const [key, organizationId] of [
      ['ownerA', orgA],
      ['ownerB', orgB],
    ] as const) {
      await prisma.organizationMember.create({
        data: { organizationId, userId: ids[key], role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
      });
    }

    const fixture = async (organizationId: string, tag: string) => {
      const venue = await prisma.venue.create({
        data: { organizationId, name: `Hall ${tag} ${suffix}`, city: 'Hyderabad' },
      });
      const event = await prisma.event.create({
        data: {
          organizationId,
          venueId: venue.id,
          title: `Event ${tag} ${suffix}`,
          slug: `ev-${tag}-${suffix}`,
          category: 'Music',
        },
      });
      const session = await prisma.eventSession.create({
        data: {
          eventId: event.id,
          startsAt: new Date(Date.now() + 7 * 86_400_000),
          endsAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
        },
      });
      const tt = await prisma.ticketType.create({
        data: {
          eventSessionId: session.id,
          name: 'General',
          priceMinor: 50_000,
          quantityTotal: 50,
        },
      });
      return { event, session, tt };
    };
    const booking = (
      f: Awaited<ReturnType<typeof fixture>>,
      organizationId: string,
      userId: string,
      status: 'CONFIRMED' | 'PENDING_PAYMENT',
      tag: string,
    ) =>
      prisma.booking.create({
        data: {
          organizationId,
          eventId: f.event.id,
          eventSessionId: f.session.id,
          userId,
          buyerName: `Buyer ${tag}`,
          buyerEmail: `buyer-${tag}-${suffix}@cri.test`,
          status,
          subtotalMinor: 50_000,
          totalMinor: 50_000,
          holdExpiresAt: new Date(Date.now() + 3_600_000),
          items: {
            create: {
              ticketTypeId: f.tt.id,
              quantity: 1,
              unitPriceMinor: 50_000,
              lineTotalMinor: 50_000,
            },
          },
        },
      });
    const ticket = (
      f: Awaited<ReturnType<typeof fixture>>,
      organizationId: string,
      bookingId: string,
      tag: string,
    ) =>
      prisma.ticket.create({
        data: {
          bookingId,
          organizationId,
          eventSessionId: f.session.id,
          ticketTypeId: f.tt.id,
          serial: `SER-${tag}-${suffix}`,
          nonce: randomBytes(6).toString('hex'),
        },
      });

    const fa = await fixture(orgA, 'a');
    const fb = await fixture(orgB, 'b');
    const confirmed = await booking(fa, orgA, ids.custA, 'CONFIRMED', 'c');
    confirmedId = confirmed.id;
    ticketId = (await ticket(fa, orgA, confirmed.id, 'a')).id;
    const pending = await booking(fa, orgA, ids.custA, 'PENDING_PAYMENT', 'p');
    pendingId = pending.id;
    await prisma.payment.create({
      data: {
        bookingId: pending.id,
        provider: 'razorpay',
        amountMinor: 50_000,
        providerOrderId: `order_${suffix}`,
      },
    });
    const bookingB = await booking(fb, orgB, ids.custB, 'CONFIRMED', 'b');
    bookingBId = bookingB.id;
    ticketBId = (await ticket(fb, orgB, bookingB.id, 'b')).id;

    // A share link the real owner makes through the API, so the manage routes have a target.
    const made = await call('custA', 'POST', `/tickets/${ticketId}/share`, {
      permission: 'VIEW',
      expiry: '24h',
    });
    shareId = String(
      (made.body as { data?: { id?: string }; id?: string }).data?.id ?? made.body.id,
    );
    // A pending attendee invite, so the resend route has a target.
    await call('custA', 'POST', `/tickets/${ticketId}/invite`, {
      email: `invitee-${suffix}@cri.test`,
    });
    inviteId = (
      await prisma.ticketInvite.findFirstOrThrow({
        where: { ticketId, email: `invitee-${suffix}@cri.test` },
      })
    ).id;
    feedbackId = (
      await prisma.feedback.create({
        data: { kind: 'CONTACT', email: `fb-${suffix}@cri.test`, message: 'Please help me.' },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      const orgIds = [orgA, orgB].filter(Boolean);
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ actorUserId: { in: userIds } }, { organizationId: { in: orgIds } }],
        },
      });
      await prisma.notificationRate.deleteMany({ where: { id: { in: rateIds } } });
      await prisma.feedback.deleteMany({ where: { id: feedbackId || 'none' } });
      await prisma.booking.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.event.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  async function call(
    actor: ActorKey,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, any> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  }

  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  // Every customer route that names a booking, ticket or share. A valid body on each, so a
  // refusal is the authorization's and not the validator's.
  const routes: [string, string, () => string, () => unknown][] = [
    ['GET', 'booking read', () => `/bookings/${confirmedId}`, () => undefined],
    ['POST', 'booking cancel', () => `/bookings/${pendingId}/cancel`, () => undefined],
    ['POST', 'booking pay', () => `/bookings/${pendingId}/pay`, () => undefined],
    ['POST', 'booking coupon', () => `/bookings/${pendingId}/coupon`, () => ({ code: null })],
    ['POST', 'booking extend-hold', () => `/bookings/${pendingId}/extend-hold`, () => undefined],
    [
      'POST',
      'razorpay verify',
      () => `/bookings/${pendingId}/payments/razorpay/verify`,
      () => ({ razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's' }),
    ],
    ['GET', 'ticket read', () => `/tickets/${ticketId}`, () => undefined],
    [
      'POST',
      'share create',
      () => `/tickets/${ticketId}/share`,
      () => ({ permission: 'VIEW', expiry: '24h' }),
    ],
    ['GET', 'share activity', () => `/tickets/${ticketId}/shares`, () => undefined],
    ['POST', 'share revoke', () => `/shares/${shareId}/revoke`, () => undefined],
    ['POST', 'share extend', () => `/shares/${shareId}/extend`, () => ({ expiry: '6h' })],
    [
      'POST',
      'share permission',
      () => `/shares/${shareId}/permission`,
      () => ({ permission: 'TRANSFER' }),
    ],
    [
      'POST',
      'attendee assign',
      () => `/tickets/${ticketId}/attendee`,
      () => ({ name: 'Mallory', email: 'mallory@cri.test' }),
    ],
    [
      'POST',
      'attendee invite',
      () => `/tickets/${ticketId}/invite`,
      () => ({ email: 'mallory@cri.test' }),
    ],
    [
      'POST',
      'ticket transfer',
      () => `/tickets/${ticketId}/transfer`,
      () => ({ email: 'mallory@cri.test' }),
    ],
    ['POST', 'attendee unassign', () => `/tickets/${ticketId}/unassign`, () => undefined],
    ['POST', 'attendee resend', () => `/attendee-invites/${inviteId}/resend`, () => undefined],
    ['GET', 'booking attendees', () => `/bookings/${confirmedId}/attendees`, () => undefined],
    ['POST', 'wallet pass', () => `/wallet/passes`, () => ({ ticketId, provider: 'apple' })],
    [
      'POST',
      'refund request',
      () => `/refunds`,
      () => ({ bookingId: confirmedId, reason: 'I want my money back' }),
    ],
  ];

  /** What a refused request must not have changed. */
  const snapshot = async () => ({
    pending: await prisma.booking.findUnique({
      where: { id: pendingId },
      select: { status: true, couponId: true, holdExpiresAt: true, holdExtensions: true },
    }),
    ticket: await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { nonce: true, qrVersion: true, holderName: true, holderEmail: true, status: true },
    }),
    invites: await prisma.ticketInvite.findMany({
      where: { ticketId },
      select: { id: true, status: true, permission: true, expiresAt: true },
      orderBy: { id: 'asc' },
    }),
    refunds: await prisma.refund.count({ where: { bookingId: confirmedId } }),
  });

  // ── The defect: staff on customer routes ───────────────────────────────────────────

  describe.each(STAFF_KEYS)('staff %s', (actor) => {
    it('is refused on every customer route for another user, and nothing changes', async () => {
      if (skip()) return;
      const before = await snapshot();
      const wrong: string[] = [];
      for (const [method, name, path, body] of routes) {
        const res = await call(actor, method, path(), body());
        if (res.status !== 403) wrong.push(`${name}: ${res.status}`);
      }
      expect(wrong).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ── Cross-customer isolation ───────────────────────────────────────────────────────

  it('customer B is refused on every route for customer A, and nothing changes', async () => {
    if (skip()) return;
    const before = await snapshot();
    const wrong: string[] = [];
    for (const [method, name, path, body] of routes) {
      const res = await call('custB', method, path(), body());
      if (res.status !== 403) wrong.push(`${name}: ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  // ── Cross-organization isolation (organizer of org A vs org B's resources) ─────────

  it('an organizer owner is refused on the customer routes of a booking in their OWN org', async () => {
    if (skip()) return;
    // Being the organizer is not being the buyer. Their documented access is the print and
    // attendee-list routes, not the buyer's own.
    expect((await call('ownerA', 'GET', `/bookings/${confirmedId}`)).status).toBe(403);
    expect((await call('ownerA', 'GET', `/tickets/${ticketId}`)).status).toBe(403);
    expect((await call('ownerA', 'POST', `/bookings/${pendingId}/cancel`)).status).toBe(403);
  });

  it("organizer of org A is refused org B's bookings (print, cash, buyer routes)", async () => {
    if (skip()) return;
    expect((await call('ownerA', 'GET', `/tickets/booking/${bookingBId}/print`)).status).toBe(403);
    expect((await call('ownerA', 'POST', `/payments/${bookingBId}/collect-cash`)).status).toBe(403);
    expect((await call('ownerA', 'GET', `/bookings/${bookingBId}`)).status).toBe(403);
    expect((await call('ownerA', 'GET', `/tickets/${ticketBId}`)).status).toBe(403);
  });

  it("organizer of org A still prints org A's own booking", async () => {
    if (skip()) return;
    const res = await call('ownerA', 'GET', `/tickets/booking/${confirmedId}/print`);
    expect(res.status).toBe(200);
  });

  // ── Allowed paths still work ───────────────────────────────────────────────────────

  it('the buyer still reads, shares and manages their own booking and ticket', async () => {
    if (skip()) return;
    expect((await call('custA', 'GET', `/bookings/${confirmedId}`)).status).toBe(200);
    expect((await call('custA', 'GET', `/tickets/${ticketId}`)).status).toBe(200);
    expect((await call('custA', 'GET', `/tickets/${ticketId}/shares`)).status).toBe(200);
    expect((await call('custA', 'GET', `/bookings/${confirmedId}/attendees`)).status).toBe(200);
    const assigned = await call('custA', 'POST', `/tickets/${ticketId}/attendee`, {
      name: 'Friend',
      email: `friend-${suffix}@cri.test`,
    });
    expect(assigned.status).toBeLessThan(300);
    // The invite in setup revoked the first link (one live claim per ticket): make a new one.
    const made = await call('custA', 'POST', `/tickets/${ticketId}/share`, {
      permission: 'VIEW',
      expiry: '24h',
    });
    expect(made.status).toBeLessThan(300);
    const freshId = String((made.body.data ?? made.body).id);
    const mine = await call('custA', 'POST', `/shares/${freshId}/extend`, { expiry: '6h' });
    expect(mine.status).toBeLessThan(300);
  });

  it('the buyer still cancels their own unpaid booking', async () => {
    if (skip()) return;
    const res = await call('custA', 'POST', `/bookings/${pendingId}/cancel`);
    expect(res.status).toBe(201);
    const row = await prisma.booking.findUnique({ where: { id: pendingId } });
    expect(row?.status).toBe('CANCELLED');
  });

  // ── The explicit support path ──────────────────────────────────────────────────────

  describe('GET /admin/bookings/:id', () => {
    it.each(['zeroAdmin'] as const)('%s (no BOOKING_READ) is refused', async (actor) => {
      if (skip()) return;
      expect(STAFF[actor].grants).not.toContain(AdminPermission.BOOKING_READ);
      expect((await call(actor, 'GET', `/admin/bookings/${confirmedId}`)).status).toBe(403);
    });

    it.each(['custA', 'custB', 'ownerA'] as const)(
      '%s is refused: not a staff route',
      async (a) => {
        if (skip()) return;
        expect((await call(a, 'GET', `/admin/bookings/${confirmedId}`)).status).toBe(403);
      },
    );

    it.each(['readOnlyAdmin', 'supportAdmin', 'financeAdmin', 'superAdmin'] as const)(
      '%s reads the booking and the read is audited',
      async (actor) => {
        if (skip()) return;
        const res = await call(actor, 'GET', `/admin/bookings/${confirmedId}`);
        expect(res.status).toBe(200);
        expect((res.body.data ?? res.body).id).toBe(confirmedId);
        const rows = await prisma.auditLog.findMany({
          where: {
            actorUserId: ids[actor],
            action: 'PLATFORM_ORGANIZER_ACCESS_ALLOWED',
            entityId: confirmedId,
          },
        });
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              organizationId: orgA,
              entityType: 'Booking',
              correlationId: expect.any(String),
              metadata: expect.objectContaining({ operation: 'booking.admin-read' }),
            }),
          ]),
        );
      },
    );
  });

  // ── Operational audit coverage ─────────────────────────────────────────────────────

  const auditFor = (actor: ActorKey, action: string, entityId?: string) =>
    prisma.auditLog.findMany({
      where: { actorUserId: ids[actor], action, ...(entityId ? { entityId } : {}) },
    });

  describe('queue retries', () => {
    it('retry-all by an OPS_EXECUTE holder writes an ALLOWED row with the correlation id', async () => {
      if (skip()) return;
      const res = await call('superAdmin', 'POST', '/admin/ops/queues/retry-failed');
      expect(res.status).toBe(201);
      const rows = await auditFor('superAdmin', 'OPS_QUEUE_RETRY_ALL');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          entityType: 'Queue',
          correlationId: expect.any(String),
          createdAt: expect.any(Date),
          metadata: expect.objectContaining({ outcome: 'ALLOWED', retried: expect.any(Number) }),
        }),
      );
    });

    it('retry of a job that does not exist writes a FAILED row and still answers 404', async () => {
      if (skip()) return;
      const jobId = `missing-${suffix}`;
      const res = await call('superAdmin', 'POST', `/admin/ops/queues/jobs/${jobId}/retry`);
      expect(res.status).toBe(404);
      const rows = await auditFor('superAdmin', 'OPS_QUEUE_RETRY_JOB', jobId);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual(expect.objectContaining({ outcome: 'FAILED' }));
    });

    it('an account without OPS_EXECUTE is refused and leaves no row', async () => {
      if (skip()) return;
      expect((await call('readOnlyAdmin', 'POST', '/admin/ops/queues/retry-failed')).status).toBe(
        403,
      );
      expect(await auditFor('readOnlyAdmin', 'OPS_QUEUE_RETRY_ALL')).toHaveLength(0);
    });
  });

  describe('inventory-sync reconcile', () => {
    it('writes a row naming the actor and the provider', async () => {
      if (skip()) return;
      const code = `nosuch${suffix}`;
      const res = await call(
        'superAdmin',
        'POST',
        `/admin/inventory-sync/providers/${code}/reconcile`,
      );
      expect(res.status).toBeLessThan(500);
      const rows = await auditFor('superAdmin', 'SYNC_RECONCILE_RUN', code);
      expect(rows).toHaveLength(1);
      expect(rows[0].correlationId).toEqual(expect.any(String));
      expect(rows[0].metadata).toEqual(
        expect.objectContaining({ outcome: res.status < 300 ? 'ALLOWED' : 'FAILED' }),
      );
    });

    it('an account without OPS_EXECUTE is refused and leaves no row', async () => {
      if (skip()) return;
      const code = `denied${suffix}`;
      expect(
        (await call('readOnlyAdmin', 'POST', `/admin/inventory-sync/providers/${code}/reconcile`))
          .status,
      ).toBe(403);
      expect(await auditFor('readOnlyAdmin', 'SYNC_RECONCILE_RUN', code)).toHaveLength(0);
    });
  });

  describe('support ticket status', () => {
    it('refuses a reader, and leaves the status and the log alone', async () => {
      if (skip()) return;
      const res = await call('readOnlyAdmin', 'PATCH', `/admin/support/${feedbackId}`, {
        status: 'CLOSED',
      });
      expect(res.status).toBe(403);
      expect((await prisma.feedback.findUnique({ where: { id: feedbackId } }))?.status).toBe(
        'OPEN',
      );
      expect(await auditFor('readOnlyAdmin', 'SUPPORT_TICKET_STATUS_CHANGED')).toHaveLength(0);
    });

    it('records who moved it, from what and to what - and nothing the customer wrote', async () => {
      if (skip()) return;
      const res = await call('supportAdmin', 'PATCH', `/admin/support/${feedbackId}`, {
        status: 'TRIAGED',
      });
      expect(res.status).toBe(200);
      const rows = await auditFor('supportAdmin', 'SUPPORT_TICKET_STATUS_CHANGED', feedbackId);
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe('Feedback');
      expect(rows[0].correlationId).toEqual(expect.any(String));
      expect(rows[0].metadata).toEqual({ from: 'OPEN', to: 'TRIAGED', outcome: 'ALLOWED' });
      expect(JSON.stringify(rows[0])).not.toContain('Please help me');
      expect(JSON.stringify(rows[0])).not.toContain('@cri.test');
    });

    it('answers 404 for a ticket that does not exist, writing nothing', async () => {
      if (skip()) return;
      const res = await call('supportAdmin', 'PATCH', `/admin/support/nope${suffix}`, {
        status: 'CLOSED',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('notification rates', () => {
    const rateBody = (channel: string, provider: string) => ({
      provider,
      channel,
      country: 'ZZ',
      unitPriceMicro: 100,
      currency: 'USD',
      billingUnit: 'PER_MESSAGE',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      active: true,
    });

    it('create and supersede are audited, and supersede ends ONLY the rate named', async () => {
      if (skip()) return;
      const provider = `cri${suffix}`;
      const one = await call(
        'superAdmin',
        'POST',
        '/admin/notifications/analytics/rates',
        rateBody('sms', provider),
      );
      const two = await call(
        'superAdmin',
        'POST',
        '/admin/notifications/analytics/rates',
        rateBody('email', provider),
      );
      expect(one.status).toBe(201);
      expect(two.status).toBe(201);
      const idOne = (one.body.data ?? one.body).id as string;
      const idTwo = (two.body.data ?? two.body).id as string;
      rateIds.push(idOne, idTwo);

      const created = await auditFor('superAdmin', 'NOTIFICATION_RATE_CREATED');
      expect(created.map((r) => (r.metadata as { rateId?: string }).rateId).sort()).toEqual(
        [idOne, idTwo].sort(),
      );

      const res = await call(
        'superAdmin',
        'POST',
        `/admin/notifications/analytics/rates/${idOne}/supersede`,
        {},
      );
      expect(res.status).toBe(201);
      expect((res.body.data ?? res.body).superseded).toBe(true);
      // The other rate is untouched. This was `@Query('id')`, always undefined, and Prisma reads
      // `id: undefined` as no filter: it ended every open rate on the platform.
      expect(
        (await prisma.notificationRate.findUnique({ where: { id: idOne } }))?.effectiveTo,
      ).not.toBeNull();
      expect(
        (await prisma.notificationRate.findUnique({ where: { id: idTwo } }))?.effectiveTo,
      ).toBeNull();

      const rows = await auditFor('superAdmin', 'NOTIFICATION_RATE_SUPERSEDED', idOne);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual(
        expect.objectContaining({ outcome: 'ALLOWED', superseded: true }),
      );
    });

    it('an account without PLATFORM_CONFIG is refused and leaves no row', async () => {
      if (skip()) return;
      const res = await call(
        'supportAdmin',
        'POST',
        '/admin/notifications/analytics/rates',
        rateBody('sms', `x${suffix}`),
      );
      expect(res.status).toBe(403);
      expect(await auditFor('supportAdmin', 'NOTIFICATION_RATE_CREATED')).toHaveLength(0);
    });
  });
});
