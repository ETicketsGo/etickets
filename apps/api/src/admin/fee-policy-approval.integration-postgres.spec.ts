import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { BookingsService } from '../bookings/bookings.service';

/**
 * Maker-checker on event and organizer fee overrides (platform fee policies), end to end. AR-10.
 *
 * Real HTTP, real signed tokens, the real guards, the real booking path, a real database with
 * the real triggers. Before this change one PLATFORM_CONFIG holder created a waiver and it
 * priced the next sale; every "pending prices nothing" and "maker cannot approve" test here
 * fails on that code.
 *
 * Its own organizer, venue and events (INR, India), so nothing else is priced by its policies.
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
    await db.$queryRaw`SELECT "approvedByUserId" FROM "PlatformFeePolicy" LIMIT 1`;
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

type Actor = 'maker' | 'maker2' | 'checker' | 'checker2' | 'superA' | 'superB' | 'reader';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };
const DAY = 86_400_000;
const P = '/admin/platform-fee-policies';

describe('integration-real-postgres: fee override maker-checker', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let bookings: BookingsService;
  let base = '';
  const suffix = `fpa${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ids = {} as Record<Actor, string>;
  const tokens = {} as Record<Actor, string>;
  const originalEnv = { ...process.env };
  let orgId = '';
  let venueId = '';
  let seq = 0;

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
  const skip = () => {
    if (!app) {
      console.warn('[integration-real-postgres] skipped: infrastructure unavailable');
      return true;
    }
    return false;
  };

  /** A published event with one session and one INR ticket type, priced Rs 500. */
  async function event() {
    const n = ++seq;
    const ev = await prisma.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `Override ${suffix} ${n}`,
        slug: `override-${suffix}-${n}`,
        category: 'Music',
        status: 'PUBLISHED',
        feeMode: 'CUSTOMER_PAYS' as never,
      },
    });
    const startsAt = new Date(Date.now() + 10 * DAY);
    const session = await prisma.eventSession.create({
      data: { eventId: ev.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
    });
    const tt = await prisma.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor: 50_000,
        currency: 'INR',
        quantityTotal: 100,
        maxPerOrder: 10,
      },
    });
    await prisma.ticketInventory.create({ data: { ticketTypeId: tt.id, quantityTotal: 100 } });
    return { eventId: ev.id, sessionId: session.id, ticketTypeId: tt.id };
  }
  const input = (e: { sessionId: string; ticketTypeId: string }) => {
    const n = ++seq;
    return {
      eventSessionId: e.sessionId,
      items: [{ ticketTypeId: e.ticketTypeId, quantity: 1 }],
      buyerName: `Buyer ${n}`,
      buyerEmail: `buyer-${n}-${suffix}@test.invalid`,
    } as never;
  };
  const fee = async (e: { sessionId: string; ticketTypeId: string }) =>
    (await bookings.quote(input(e))).fees.bookingFeeMinor;

  const waiver = (eventId: string) => ({
    scope: 'EVENT',
    eventId,
    kind: 'WAIVE',
    reason: 'Charity night, no booking fee',
  });
  async function pending(actor: Actor, eventId: string) {
    const res = await call(actor, 'POST', P, waiver(eventId));
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number; status: string };
  }
  async function approved(eventId: string) {
    const p = await pending('maker', eventId);
    const res = await call('checker', 'POST', `${P}/${p.id}/approve`, { version: p.version });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number; status: string };
  }

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
    bookings = app.get(BookingsService);

    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    const makeUser = async (key: Actor, roles: string[], grants: string[] = []) => {
      const user = await prisma.user.create({
        data: {
          email: `${key}-${suffix}@fpa.test`.toLowerCase(),
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
    await makeUser('maker', ['ADMIN'], ['PLATFORM_CONFIG', 'PLATFORM_CONFIG_READ']);
    await makeUser('maker2', ['ADMIN'], ['PLATFORM_CONFIG', 'PLATFORM_CONFIG_READ']);
    await makeUser('checker', ['ADMIN'], ['FEE_SCHEDULE_APPROVE', 'PLATFORM_CONFIG_READ']);
    await makeUser('checker2', ['ADMIN'], ['FEE_SCHEDULE_APPROVE', 'PLATFORM_CONFIG_READ']);
    await makeUser('superA', ['ADMIN', 'SUPER_ADMIN']);
    await makeUser('superB', ['ADMIN', 'SUPER_ADMIN']);
    await makeUser('reader', ['ADMIN'], ['PLATFORM_CONFIG_READ']);

    orgId = (
      await prisma.organization.create({
        data: {
          name: `Override Org ${suffix}`,
          slug: `override-org-${suffix}`,
          status: 'APPROVED',
        },
      })
    ).id;
    venueId = (
      await prisma.venue.create({
        data: {
          organizationId: orgId,
          name: `Override Hall ${suffix}`,
          city: 'Vijayawada',
          country: 'India',
          timezone: 'Asia/Kolkata',
        },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(ids);
      const bookingWhere = { organizationId: orgId };
      const steps: Array<() => Promise<unknown>> = [
        () => prisma.bookingTaxLine.deleteMany({ where: { booking: bookingWhere } }),
        () => prisma.payment.deleteMany({ where: { booking: bookingWhere } }),
        () => prisma.bookingItem.deleteMany({ where: { booking: bookingWhere } }),
        () => prisma.booking.deleteMany({ where: bookingWhere }),
        () =>
          prisma.platformFeePolicyEvent.deleteMany({
            where: { policy: { organizationId: orgId } },
          }),
        () => prisma.platformFeePolicy.deleteMany({ where: { organizationId: orgId } }),
        () =>
          prisma.ticketInventory.deleteMany({
            where: { ticketType: { eventSession: { event: { organizationId: orgId } } } },
          }),
        () =>
          prisma.ticketType.deleteMany({
            where: { eventSession: { event: { organizationId: orgId } } },
          }),
        () => prisma.eventSession.deleteMany({ where: { event: { organizationId: orgId } } }),
        () => prisma.event.deleteMany({ where: { organizationId: orgId } }),
        () => prisma.venue.deleteMany({ where: { organizationId: orgId } }),
        () => prisma.organization.deleteMany({ where: { id: orgId } }),
        () => prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } }),
        () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } }),
        () => prisma.adminGrant.deleteMany({ where: { userId: { in: userIds } } }),
        () => prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ];
      for (const step of steps) await step().catch(() => undefined);
    }
    await app?.close();
    process.env = originalEnv;
  }, 60_000);

  // ── Creation ───────────────────────────────────────────────────────────────────────

  it('a new override waits for approval and prices nothing until then', async () => {
    if (skip()) return;
    const e = await event();
    expect(await fee(e)).toBe(1_500); // the schedule
    const p = await pending('maker', e.eventId);
    expect(p.status).toBe('PENDING_APPROVAL');
    expect(await fee(e)).toBe(1_500); // still the schedule: a pending waiver is not applied
    const held = await bookings.create(null, input(e));
    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: (held as { id: string }).id },
    });
    expect(row.bookingFeeMinor).toBe(1_500);
    expect(row.feePolicyId).toBeNull();

    const res = await call('checker', 'POST', `${P}/${p.id}/approve`, {
      version: p.version,
      note: 'Checked with the charity contract',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.approvedByUserId).toBe(ids.checker);
    expect(await fee(e)).toBe(0);
    // The unpaid hold taken before approval keeps the price it was quoted.
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.bookingFeeMinor).toBe(1_500);
  });

  it('the creator cannot approve or reject their own override, even as a super admin', async () => {
    if (skip()) return;
    const e = await event();
    const p = await pending('superA', e.eventId);
    const self = await call('superA', 'POST', `${P}/${p.id}/approve`, { version: p.version });
    expect(self.status).toBe(403);
    expect(self.body.details.reason).toBe('APPROVER_IS_MAKER');
    const selfReject = await call('superA', 'POST', `${P}/${p.id}/reject`, {
      version: p.version,
      note: 'Never mind',
    });
    expect(selfReject.status).toBe(403);
    const refused = await prisma.auditLog.findFirst({
      where: { action: 'PLATFORM_FEE_POLICY_APPROVAL_REFUSED', entityId: p.id },
    });
    expect(refused?.actorUserId).toBe(ids.superA);
    expect(await fee(e)).toBe(1_500);
    // A different super admin may.
    const other = await call('superB', 'POST', `${P}/${p.id}/approve`, { version: p.version });
    expect(other.status).toBe(201);
    expect(await fee(e)).toBe(0);
  });

  it('only FEE_SCHEDULE_APPROVE may decide; only PLATFORM_CONFIG may propose', async () => {
    if (skip()) return;
    const e = await event();
    expect((await call('reader', 'POST', P, waiver(e.eventId))).status).toBe(403);
    expect((await call('checker', 'POST', P, waiver(e.eventId))).status).toBe(403);
    const p = await pending('maker', e.eventId);
    // Another maker holds PLATFORM_CONFIG but not the approval capability.
    const byMaker = await call('maker2', 'POST', `${P}/${p.id}/approve`, { version: p.version });
    expect(byMaker.status).toBe(403);
    expect(
      (await call('reader', 'POST', `${P}/${p.id}/approve`, { version: p.version })).status,
    ).toBe(403);
    // Withdraw is the maker's own: another maker cannot.
    const notMine = await call('maker2', 'POST', `${P}/${p.id}/withdraw`, { version: p.version });
    expect(notMine.status).toBe(403);
    expect(notMine.body.details.reason).toBe('NOT_THE_MAKER');
    const mine = await call('maker', 'POST', `${P}/${p.id}/withdraw`, { version: p.version });
    expect(mine.status).toBe(201);
    expect(mine.body.status).toBe('WITHDRAWN');
    const late = await call('checker', 'POST', `${P}/${p.id}/approve`, {
      version: mine.body.version,
    });
    expect(late.status).toBe(409);
    expect(await fee(e)).toBe(1_500);
  });

  it('two approvers at the same moment: exactly one approval commits', async () => {
    if (skip()) return;
    const e = await event();
    const p = await pending('maker', e.eventId);
    const [a, b] = await Promise.all([
      call('checker', 'POST', `${P}/${p.id}/approve`, { version: p.version }),
      call('checker2', 'POST', `${P}/${p.id}/approve`, { version: p.version }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const history = await prisma.platformFeePolicyEvent.findMany({
      where: { policyId: p.id, action: 'APPROVED' },
    });
    expect(history).toHaveLength(1);
    // A stale version is refused too.
    const stale = await call('checker', 'POST', `${P}/${p.id}/approve`, { version: p.version });
    expect(stale.status).toBe(409);
  });

  it('a rejected override never prices, stays rejected, and frees the slot', async () => {
    if (skip()) return;
    const e = await event();
    const p = await pending('maker', e.eventId);
    // While it waits, a second override for the same event and time is refused.
    const second = await call('maker2', 'POST', P, waiver(e.eventId));
    expect(second.status).toBe(409);
    const short = await call('checker', 'POST', `${P}/${p.id}/reject`, {
      version: p.version,
      note: 'no',
    });
    expect(short.status).toBe(400);
    const rej = await call('checker', 'POST', `${P}/${p.id}/reject`, {
      version: p.version,
      note: 'No contract on file for this waiver',
    });
    expect(rej.status).toBe(201);
    expect(rej.body.status).toBe('REJECTED');
    expect(rej.body.rejectionNote).toBe('No contract on file for this waiver');
    expect(await fee(e)).toBe(1_500);
    const again = await call('checker2', 'POST', `${P}/${p.id}/approve`, {
      version: rej.body.version,
    });
    expect(again.status).toBe(409);
    expect((await call('maker2', 'POST', P, waiver(e.eventId))).status).toBe(201);
    // The maker was told.
    const told = await prisma.notification.findMany({
      where: { type: 'FEE_SCHEDULE_DECIDED', userId: ids.maker },
    });
    expect(
      told.some(
        (n) =>
          (n.payload as { policyId?: string; decision?: string }).policyId === p.id &&
          (n.payload as { decision?: string }).decision === 'REJECTED',
      ),
    ).toBe(true);
  });

  it('approvers are notified of a new override; its maker is not', async () => {
    if (skip()) return;
    const e = await event();
    const p = await pending('maker', e.eventId);
    const asks = await prisma.notification.findMany({
      where: { type: 'FEE_SCHEDULE_AWAITING_APPROVAL', userId: { in: Object.values(ids) } },
    });
    const forThis = asks.filter((n) => (n.payload as { policyId?: string }).policyId === p.id);
    const to = new Set(forThis.map((n) => n.userId));
    expect(to.has(ids.maker)).toBe(false);
    expect(to.has(ids.checker)).toBe(true);
    expect((forThis[0]!.payload as { kind?: string }).kind).toBe('POLICY_SUBMITTED');
  });

  // ── Switching off (the fee goes back UP to the schedule) ─────────────────────────────

  it('switching off is a request: the override keeps pricing until a second person approves', async () => {
    if (skip()) return;
    const e = await event();
    const live = await approved(e.eventId);
    const booked = await bookings.create(null, input(e));
    const bookedId = (booked as { id: string }).id;
    await prisma.booking.update({
      where: { id: bookedId },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    const ask = await call('maker', 'POST', `${P}/${live.id}/deactivate`, {
      version: live.version,
      reason: 'Charity night is over now',
    });
    expect(ask.status).toBe(201);
    expect(ask.body.status).toBe('ACTIVE');
    expect(ask.body.deactivationRequest.requestedByUserId).toBe(ids.maker);
    expect(await fee(e)).toBe(0); // still waived

    // The fee goes UP if this is approved: the estimate says so.
    const impact = await call('checker', 'GET', `${P}/${live.id}/impact?days=30`);
    expect(impact.status).toBe(200);
    expect(impact.body.mode).toBe('DEACTIVATE');
    expect(impact.body.direction).toBe('INCREASE');
    expect(impact.body.currencies[0]).toMatchObject({
      currency: 'INR',
      orders: 1,
      deltaMinor: 1_500,
    });

    const twice = await call('maker2', 'POST', `${P}/${live.id}/deactivate`, {
      version: ask.body.version,
      reason: 'Switch it off please',
    });
    expect(twice.status).toBe(409);

    const done = await call('checker', 'POST', `${P}/${live.id}/deactivation/approve`, {
      version: ask.body.version,
    });
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('INACTIVE');
    expect(done.body.deactivatedByUserId).toBe(ids.checker);
    expect(await fee(e)).toBe(1_500);
    // The confirmed booking keeps exactly what it was charged.
    const kept = await prisma.booking.findUniqueOrThrow({ where: { id: bookedId } });
    expect(kept.bookingFeeMinor).toBe(0);
    expect(kept.feePolicyId).toBe(live.id);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: live.id, entityType: 'PlatformFeePolicy' },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'PLATFORM_FEE_POLICY_CREATED',
      'PLATFORM_FEE_POLICY_APPROVED',
      'PLATFORM_FEE_POLICY_DEACTIVATION_REQUESTED',
      'PLATFORM_FEE_POLICY_DEACTIVATED',
    ]);
  });

  it('the requester cannot approve their own switch-off; reject and withdraw leave it live', async () => {
    if (skip()) return;
    const e = await event();
    const live = await approved(e.eventId);
    // A super admin asks to switch it off; holding every capability does not let them approve
    // their own request.
    const ask = await call('superA', 'POST', `${P}/${live.id}/deactivate`, {
      version: live.version,
      reason: 'Organizer asked to end the waiver',
    });
    expect(ask.status).toBe(201);
    const self = await call('superA', 'POST', `${P}/${live.id}/deactivation/approve`, {
      version: ask.body.version,
    });
    expect(self.status).toBe(403);
    expect(self.body.details.reason).toBe('APPROVER_IS_MAKER');
    const rej = await call('checker', 'POST', `${P}/${live.id}/deactivation/reject`, {
      version: ask.body.version,
      note: 'Contract runs to the end of the month',
    });
    expect(rej.status).toBe(201);
    expect(rej.body.status).toBe('ACTIVE');
    expect(rej.body.deactivationRequest).toBeNull();
    expect(await fee(e)).toBe(0);

    const ask2 = await call('maker', 'POST', `${P}/${live.id}/deactivate`, {
      version: rej.body.version,
      reason: 'Ending it a little early',
    });
    const otherWithdraw = await call('maker2', 'POST', `${P}/${live.id}/deactivation/withdraw`, {
      version: ask2.body.version,
    });
    expect(otherWithdraw.status).toBe(403);
    const withdrawn = await call('maker', 'POST', `${P}/${live.id}/deactivation/withdraw`, {
      version: ask2.body.version,
    });
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.body.deactivationRequest).toBeNull();
    expect(await fee(e)).toBe(0);
  });

  it('the emergency switch-off: one person, both capabilities, a real reason, recorded', async () => {
    if (skip()) return;
    const e = await event();
    const live = await approved(e.eventId);
    const makerOnly = await call('maker', 'POST', `${P}/${live.id}/emergency-deactivate`, {
      version: live.version,
      reason: 'This waiver was a mistake, stop it now please',
    });
    expect(makerOnly.status).toBe(403); // PLATFORM_CONFIG alone is not enough
    const checkerOnly = await call('checker', 'POST', `${P}/${live.id}/emergency-deactivate`, {
      version: live.version,
      reason: 'This waiver was a mistake, stop it now please',
    });
    expect(checkerOnly.status).toBe(403); // nor is FEE_SCHEDULE_APPROVE alone
    const tooShort = await call('superA', 'POST', `${P}/${live.id}/emergency-deactivate`, {
      version: live.version,
      reason: 'mistake',
    });
    expect(tooShort.status).toBe(400);
    const done = await call('superA', 'POST', `${P}/${live.id}/emergency-deactivate`, {
      version: live.version,
      reason: 'Waiver applied to the wrong event, buyers are not paying the fee',
    });
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('INACTIVE');
    expect(done.body.emergencyDeactivation).toBe(true);
    expect(await fee(e)).toBe(1_500);
    const ev = await prisma.platformFeePolicyEvent.findFirst({
      where: { policyId: live.id, action: 'EMERGENCY_DEACTIVATED' },
    });
    expect(ev?.actorUserId).toBe(ids.superA);
    const review = await prisma.notification.findMany({
      where: { type: 'FEE_SCHEDULE_AWAITING_APPROVAL', userId: { in: Object.values(ids) } },
    });
    const forThis = review.filter(
      (n) =>
        (n.payload as { policyId?: string }).policyId === live.id &&
        (n.payload as { kind?: string }).kind === 'POLICY_EMERGENCY_DEACTIVATED',
    );
    const to = new Set(forThis.map((n) => n.userId));
    expect(to.has(ids.superA)).toBe(false);
    expect(to.has(ids.checker)).toBe(true);
  });

  it('the impact estimate of a pending waiver is a decrease, per currency', async () => {
    if (skip()) return;
    const e = await event();
    const b = await bookings.create(null, input(e));
    await prisma.booking.update({
      where: { id: (b as { id: string }).id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
    const p = await pending('maker', e.eventId);
    const impact = await call('checker', 'GET', `${P}/${p.id}/impact`);
    expect(impact.status).toBe(200);
    expect(impact.body).toMatchObject({ mode: 'APPROVE', direction: 'DECREASE', orders: 1 });
    expect(impact.body.currencies).toEqual([
      expect.objectContaining({
        currency: 'INR',
        beforeFeeMinor: 1_500,
        afterFeeMinor: 0,
        deltaMinor: -1_500,
        lower: 1,
      }),
    ]);
    const detail = await call('maker', 'GET', `${P}/${p.id}`);
    expect(detail.body.pendingDecision).toBe('POLICY');
    expect(detail.body.viewerBlockedReason).toBe('CREATOR');
    const forChecker = await call('checker', 'GET', `${P}/${p.id}`);
    expect(forChecker.body.viewerBlockedReason).toBeNull();
  });

  // ── The database refuses what the service would never do ──────────────────────────────

  it('the database refuses an unapproved live policy, edited terms, and rewritten history', async () => {
    if (skip()) return;
    const e = await event();
    const base = {
      scope: 'EVENT' as const,
      eventId: e.eventId,
      organizationId: orgId,
      kind: 'WAIVE' as const,
      startsAt: new Date(),
      reason: 'Direct database write in a test',
      createdByUserId: ids.maker,
    };
    await expect(prisma.platformFeePolicy.create({ data: base })).rejects.toThrow(
      /PENDING_APPROVAL/,
    );
    await expect(
      prisma.platformFeePolicy.create({ data: { ...base, approvedByUserId: ids.maker } }),
    ).rejects.toThrow(/PENDING_APPROVAL/);

    const p = await pending('maker', e.eventId);
    await expect(
      prisma.platformFeePolicy.update({ where: { id: p.id }, data: { status: 'ACTIVE' } }),
    ).rejects.toThrow(/approver other than its creator/);
    await expect(
      prisma.platformFeePolicy.update({
        where: { id: p.id },
        data: { status: 'ACTIVE', approvedByUserId: ids.maker },
      }),
    ).rejects.toThrow(/approver other than its creator/);

    const ok = await call('checker', 'POST', `${P}/${p.id}/approve`, { version: p.version });
    expect(ok.status).toBe(201);
    await expect(
      prisma.platformFeePolicy.update({
        where: { id: p.id },
        data: { kind: 'FIXED', feeMinor: 1 },
      }),
    ).rejects.toThrow(/terms cannot change/);
    await expect(
      prisma.platformFeePolicy.update({ where: { id: p.id }, data: { status: 'INACTIVE' } }),
    ).rejects.toThrow(/approved request or the emergency path/);
    await expect(
      prisma.platformFeePolicy.update({
        where: { id: p.id },
        data: { approvedByUserId: ids.checker2 },
      }),
    ).rejects.toThrow(/approver cannot change/);
    const h = await prisma.platformFeePolicyEvent.findFirstOrThrow({ where: { policyId: p.id } });
    await expect(
      prisma.platformFeePolicyEvent.update({ where: { id: h.id }, data: { reason: 'edited' } }),
    ).rejects.toThrow(/append-only/);

    const off = await call('superA', 'POST', `${P}/${p.id}/emergency-deactivate`, {
      version: ok.body.version,
      reason: 'Closing the trigger test policy for good',
    });
    expect(off.status).toBe(201);
    await expect(
      prisma.platformFeePolicy.update({ where: { id: p.id }, data: { status: 'ACTIVE' } }),
    ).rejects.toThrow(/final/);
  });
});
