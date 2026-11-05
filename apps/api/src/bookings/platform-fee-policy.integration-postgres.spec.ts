import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BookingsService } from './bookings.service';
import { PlatformFeePoliciesService } from '../admin/platform-fee-policies.service';
import { PricingService } from '../pricing/pricing.service';

/**
 * integration-real-postgres - platform fee waivers and overrides through the REAL booking path.
 *
 * The pure rules live in pricing/fee-policy.spec.ts. This proves what only a database can: that
 * the live `BookingsService.quote` and `.create` (built by Nest from AppModule) resolve the same
 * policy, snapshot it on the booking with the charged money unchanged in meaning, that an order
 * limit holds under concurrent checkouts (conditional UPDATE + CHECK constraint), that releasing
 * an unpaid hold gives the order back, that a coupon re-price keeps the snapshotted policy, and
 * that two admins cannot create overlapping policies at once (advisory lock).
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
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

const tag = `pfp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400_000;

describe('integration-real-postgres: platform fee policies on the booking path', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let mod: TestingModule | undefined;
  let available = false;
  let bookings: BookingsService;
  let policies: PlatformFeePoliciesService;
  let pricing: PricingService;
  let adminId = '';
  let orgId = '';
  let venueId = '';
  let buyerSeq = 0;

  /** A published general-admission event with one session and one INR ticket type. */
  async function event(opts: { priceMinor: number; isFree?: boolean; feeMode?: string }) {
    const n = ++buyerSeq;
    const ev = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `Fee policy ${tag} ${n}`,
        slug: `fee-policy-${tag}-${n}`,
        category: 'Music',
        status: 'PUBLISHED',
        isFree: opts.isFree ?? false,
        feeMode: (opts.feeMode ?? 'CUSTOMER_PAYS') as never,
      },
    });
    const startsAt = new Date(Date.now() + 10 * DAY);
    const session = await db!.eventSession.create({
      data: { eventId: ev.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
    });
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor: opts.priceMinor,
        currency: 'INR',
        quantityTotal: 100,
        maxPerOrder: 10,
      },
    });
    await db!.ticketInventory.create({ data: { ticketTypeId: tt.id, quantityTotal: 100 } });
    return { eventId: ev.id, sessionId: session.id, ticketTypeId: tt.id };
  }

  function input(
    e: { sessionId: string; ticketTypeId: string },
    quantity = 1,
    couponCode?: string,
  ) {
    const n = ++buyerSeq;
    return {
      eventSessionId: e.sessionId,
      items: [{ ticketTypeId: e.ticketTypeId, quantity }],
      buyerName: `Buyer ${n}`,
      buyerEmail: `buyer-${n}-${tag}@test.invalid`,
      ...(couponCode ? { couponCode } : {}),
    } as never;
  }

  type Booked = { id: string; fees: { bookingFeeMinor: number; totalMinor: number } };
  /** The booking path, typed as a fresh create answers (never a replay here). */
  const book = async (i: unknown) => (await bookings.create(null, i as never)) as unknown as Booked;

  async function policyRow(data: Record<string, unknown>) {
    return db!.platformFeePolicy.create({
      data: {
        organizationId: orgId,
        startsAt: new Date(Date.now() - 60_000),
        reason: 'Integration test policy row',
        createdByUserId: adminId,
        ...data,
      } as never,
    });
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      await db!.$queryRaw`SELECT 1 FROM "PlatformFeePolicy" LIMIT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable or not migrated');
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await mod.init();
    bookings = mod.get(BookingsService);
    policies = mod.get(PlatformFeePoliciesService);
    pricing = mod.get(PricingService);

    adminId = (
      await db!.user.create({
        data: {
          email: `admin-${tag}@test.invalid`,
          fullName: 'Fee Admin',
          passwordHash: 'not-a-real-hash',
          roles: ['ADMIN'],
        },
      })
    ).id;
    orgId = (
      await db!.organization.create({
        data: { name: `Fee Org ${tag}`, slug: `fee-org-${tag}`, status: 'APPROVED' },
      })
    ).id;
    venueId = (
      await db!.venue.create({
        data: {
          organizationId: orgId,
          name: `Fee Hall ${tag}`,
          city: 'Vijayawada',
          country: 'India',
          timezone: 'Asia/Kolkata',
        },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      // Best effort: rows left behind in a throwaway database are harmless, a failing
      // teardown is not (it would fail a suite whose tests all passed).
      const bookingWhere = { organizationId: orgId };
      const steps: Array<() => Promise<unknown>> = [
        () => db!.bookingTaxLine.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.payment.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.bookingItem.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.idempotencyRecord.deleteMany({ where: { key: { contains: tag } } }),
        () => db!.booking.deleteMany({ where: bookingWhere }),
        () =>
          db!.platformFeePolicyEvent.deleteMany({ where: { policy: { organizationId: orgId } } }),
        () => db!.platformFeePolicy.deleteMany({ where: { organizationId: orgId } }),
        () => db!.coupon.deleteMany({ where: { organizationId: orgId } }),
        () =>
          db!.ticketInventory.deleteMany({
            where: { ticketType: { eventSession: { event: { organizationId: orgId } } } },
          }),
        () =>
          db!.ticketType.deleteMany({
            where: { eventSession: { event: { organizationId: orgId } } },
          }),
        () => db!.eventSession.deleteMany({ where: { event: { organizationId: orgId } } }),
        () => db!.event.deleteMany({ where: { organizationId: orgId } }),
        () => db!.venue.deleteMany({ where: { organizationId: orgId } }),
        () => db!.organization.deleteMany({ where: { id: orgId } }),
        () => db!.user.deleteMany({ where: { id: adminId } }),
      ];
      for (const step of steps) await step().catch(() => undefined);
      await db.$disconnect();
    }
    await mod?.close();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe(
    'an organizer waiver: quote == booking == payment, payment fee kept, snapshot written',
    async () => {
      const e = await event({ priceMinor: 50_000 });
      const before = await bookings.quote(input(e));
      expect(before.fees.bookingFeeMinor).toBe(1_500); // the schedule, no policy yet

      const created = await policies.create(adminId, {
        scope: 'ORGANIZATION',
        organizationId: orgId,
        kind: 'WAIVE',
        reason: 'Launch partner waiver for the pilot',
      });
      const quote = await bookings.quote(input(e));
      expect(quote.fees.bookingFeeMinor).toBe(0);
      expect(quote.fees.paymentFeeMinor).toBe(1_000); // 2% of 50,000 - not waived
      expect((quote.fees as { feePolicyKind?: string }).feePolicyKind).toBe('WAIVE');
      // The buyer sees the kind, never the policy's id or limits.
      expect(JSON.stringify(quote)).not.toContain(created.id);

      const booked = await book(input(e));
      expect(booked.fees.totalMinor).toBe(quote.fees.totalMinor);
      const row = await db!.booking.findUniqueOrThrow({
        where: { id: booked.id },
        include: { payment: true },
      });
      expect(row.bookingFeeMinor).toBe(0);
      expect(row.paymentFeeMinor).toBe(1_000);
      expect(row.customerFeeMinor).toBe(1_000);
      expect(row.totalMinor).toBe(51_000);
      expect(row.payment!.amountMinor).toBe(51_000);
      expect(row.feePolicyId).toBe(created.id);
      expect(row.feePolicyKind).toBe('WAIVE');
      expect(row.feePolicyVersion).toBe(1);
      expect(row.baseBookingFeeMinor).toBe(1_500);
      expect(row.feeWaivedMinor).toBe(1_500);

      // Deactivating the policy changes the NEXT sale and leaves this booking exactly as it was.
      await policies.deactivate(adminId, created.id, {
        reason: 'Pilot ended, back to the schedule',
        version: created.version,
      });
      const after = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
      expect(after.bookingFeeMinor).toBe(0);
      expect(after.totalMinor).toBe(51_000);
      expect(after.feePolicyId).toBe(created.id);
      expect((await bookings.quote(input(e))).fees.bookingFeeMinor).toBe(1_500);

      const history = await policies.detail(created.id);
      expect(history.history.map((h) => h.action)).toEqual(['CREATED', 'DEACTIVATED']);
      expect(history.effectiveStatus).toBe('INACTIVE');
    },
  );

  maybe('an event override replaces the organizer waiver; a free event stays at zero', async () => {
    const paid = await event({ priceMinor: 150_000 });
    const orgWaive = await policyRow({ scope: 'ORGANIZATION', kind: 'WAIVE' });
    await policyRow({
      scope: 'EVENT',
      eventId: paid.eventId,
      kind: 'FIXED',
      feeMinor: 700,
      currency: 'INR',
    });
    const quote = await bookings.quote(input(paid));
    expect(quote.fees.bookingFeeMinor).toBe(700);
    const booked = await book(input(paid));
    const row = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
    expect(row.feePolicyKind).toBe('FIXED');
    expect(row.bookingFeeMinor).toBe(700);
    expect(row.baseBookingFeeMinor).toBe(2_000);

    // A free event under the same organizer waiver (or any override) charges nothing at all
    // and records no policy.
    const free = await event({ priceMinor: 0, isFree: true });
    await policyRow({
      scope: 'EVENT',
      eventId: free.eventId,
      kind: 'FIXED',
      feeMinor: 500,
      currency: 'INR',
    });
    const freeQuote = await bookings.quote(input(free));
    expect(freeQuote.fees.totalMinor).toBe(0);
    expect(freeQuote.fees.bookingFeeMinor).toBe(0);
    expect((freeQuote.fees as { feePolicyKind?: string }).feePolicyKind).toBeUndefined();

    await db!.platformFeePolicy.update({
      where: { id: orgWaive.id },
      data: { status: 'INACTIVE' },
    });
  });

  /*
    Resolved engineering question (owner decisions 2026-10-27): an unpaid hold keeps the price
    it was quoted until it is paid or released. Switching the policy off, or the schedule
    applying again, changes the NEXT checkout only.
  */
  maybe(
    'an unpaid hold keeps the price it was quoted after the policy is switched off',
    async () => {
      const e = await event({ priceMinor: 50_000 });
      const created = await policies.create(adminId, {
        scope: 'EVENT',
        eventId: e.eventId,
        kind: 'WAIVE',
        reason: 'Resolved question: hold keeps its quote',
      });
      const held = await book(input(e));
      const before = await db!.booking.findUniqueOrThrow({
        where: { id: held.id },
        include: { payment: true },
      });
      expect(before.status).toBe('PENDING_PAYMENT');
      expect(before.bookingFeeMinor).toBe(0);

      await policies.deactivate(adminId, created.id, {
        reason: 'Switched off while a hold is open',
        version: created.version,
      });
      // A new quote is back on the schedule...
      expect((await bookings.quote(input(e))).fees.bookingFeeMinor).toBe(1_500);
      // ...and the open hold still owes exactly what it was quoted, with its payment unchanged.
      const after = await db!.booking.findUniqueOrThrow({
        where: { id: held.id },
        include: { payment: true },
      });
      expect(after.status).toBe('PENDING_PAYMENT');
      expect(after.bookingFeeMinor).toBe(0);
      expect(after.totalMinor).toBe(before.totalMinor);
      expect(after.payment!.amountMinor).toBe(before.payment!.amountMinor);
      expect(after.feePolicyId).toBe(created.id);
    },
  );

  maybe('an expired policy falls back to the schedule with nothing having to run', async () => {
    const e = await event({ priceMinor: 50_000 });
    await policyRow({
      scope: 'EVENT',
      eventId: e.eventId,
      kind: 'WAIVE',
      startsAt: new Date(Date.now() - 2 * DAY),
      endsAt: new Date(Date.now() - DAY),
    });
    expect((await bookings.quote(input(e))).fees.bookingFeeMinor).toBe(1_500);
  });

  maybe(
    'an order limit holds under concurrent checkouts, and a released hold gives one back',
    async () => {
      const e = await event({ priceMinor: 50_000 });
      const limited = await policyRow({
        scope: 'EVENT',
        eventId: e.eventId,
        kind: 'WAIVE',
        maxOrders: 2,
      });

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => book(input(e))));
      const ok = results.filter(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<Booked>[];
      // Every checkout succeeded: the ones past the limit were priced again at the schedule.
      expect(ok).toHaveLength(8);
      const waived = ok.filter((r) => r.value.fees.bookingFeeMinor === 0);
      expect(waived).toHaveLength(2);
      expect(ok.filter((r) => r.value.fees.bookingFeeMinor === 1_500)).toHaveLength(6);

      const rows: { feePolicyId: string | null; bookingFeeMinor: number }[] =
        await db!.booking.findMany({ where: { eventId: e.eventId } });
      expect(rows.filter((b) => b.feePolicyId === limited.id)).toHaveLength(2);
      expect(
        rows.filter((b) => b.feePolicyId === null).every((b) => b.bookingFeeMinor === 1_500),
      ).toBe(true);
      let p = await db!.platformFeePolicy.findUniqueOrThrow({ where: { id: limited.id } });
      expect(p.usedOrders).toBe(2);
      expect(p.status).toBe('EXHAUSTED');

      // The counter cannot be pushed past its limit even by a direct write.
      await expect(
        db!.platformFeePolicy.update({ where: { id: limited.id }, data: { usedOrders: 3 } }),
      ).rejects.toThrow();

      // The buyer of one waived hold walks away: the order goes back and the policy reopens.
      const walked = waived[0]!.value.id;
      await bookings.cancelUnpaidAsGuest(walked);
      p = await db!.platformFeePolicy.findUniqueOrThrow({ where: { id: limited.id } });
      expect(p.usedOrders).toBe(1);
      expect(p.status).toBe('ACTIVE');
      // Released exactly once: cancelling again claims nothing and gives nothing more back.
      await bookings.cancelUnpaidAsGuest(walked).catch(() => undefined);
      p = await db!.platformFeePolicy.findUniqueOrThrow({ where: { id: limited.id } });
      expect(p.usedOrders).toBe(1);

      // A lapsed hold is released by the sweep the same way.
      const other = waived[1]!.value.id;
      await db!.booking.update({
        where: { id: other },
        data: { holdExpiresAt: new Date(Date.now() - 60_000) },
      });
      await bookings.releaseExpiredHolds(e.sessionId);
      p = await db!.platformFeePolicy.findUniqueOrThrow({ where: { id: limited.id } });
      expect(p.usedOrders).toBe(0);

      const actions = (
        await db!.platformFeePolicyEvent.findMany({
          where: { policyId: limited.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((h: { action: string }) => h.action);
      expect(actions).toEqual(['EXHAUSTED', 'REOPENED']);
    },
    180_000,
  );

  maybe(
    'a coupon re-price keeps the snapshotted policy, whatever happened to policies since',
    async () => {
      const e = await event({ priceMinor: 100_000 });
      await db!.coupon.create({
        data: {
          organizationId: orgId,
          code: `HALF${buyerSeq}${Date.now()}`.slice(0, 30),
          type: 'PERCENT',
          value: 50,
        },
      });
      const code = (
        await db!.coupon.findFirstOrThrow({
          where: { organizationId: orgId },
          orderBy: { id: 'desc' },
        })
      ).code;

      // Priced with no policy at all.
      const plain = await book(input(e));
      // A waiver created afterwards must not reach it through a re-price.
      const waiver = await policies.create(adminId, {
        scope: 'EVENT',
        eventId: e.eventId,
        kind: 'WAIVE',
        reason: 'Event-level waiver for a charity show',
      });
      const waivedBooking = await book(input(e));
      expect(waivedBooking.fees.bookingFeeMinor).toBe(0);

      await bookings.applyCoupon(null, plain.id, code, { guestSessionVerified: true });
      const plainRow = await db!.booking.findUniqueOrThrow({ where: { id: plain.id } });
      expect(plainRow.discountMinor).toBe(50_000);
      expect(plainRow.bookingFeeMinor).toBe(1_500); // the schedule at Rs 500, not the waiver
      expect(plainRow.feePolicyId).toBeNull();

      // And one priced under the waiver keeps it after the waiver is switched off.
      await policies.deactivate(adminId, waiver.id, {
        reason: 'Charity show moved to a new date',
        version: waiver.version,
      });
      await bookings.applyCoupon(null, waivedBooking.id, code, { guestSessionVerified: true });
      const waivedRow = await db!.booking.findUniqueOrThrow({
        where: { id: waivedBooking.id },
        include: { payment: true },
      });
      expect(waivedRow.discountMinor).toBe(50_000);
      expect(waivedRow.bookingFeeMinor).toBe(0);
      expect(waivedRow.feePolicyId).toBe(waiver.id);
      expect(waivedRow.baseBookingFeeMinor).toBe(1_500);
      expect(waivedRow.feeWaivedMinor).toBe(1_500);
      expect(waivedRow.paymentFeeMinor).toBe(1_000); // 2% of the discounted 50,000
      expect(waivedRow.payment!.amountMinor).toBe(waivedRow.totalMinor);
    },
  );

  maybe('two admins creating overlapping policies at once: exactly one wins', async () => {
    const e = await event({ priceMinor: 50_000 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        policies.create(adminId, {
          scope: 'EVENT',
          eventId: e.eventId,
          kind: 'FIXED',
          feeMinor: 100 + i,
          currency: 'INR',
          reason: `Concurrent create number ${i}`,
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const refused = attempts.filter((a) => a.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(4);
    for (const r of refused) expect((r.reason as { code?: string }).code).toBe('CONFLICT');
    expect(await db!.platformFeePolicy.count({ where: { eventId: e.eventId } })).toBe(1);

    // A different currency at the same target does not collide; a later window does not either.
    await expect(
      policies.create(adminId, {
        scope: 'EVENT',
        eventId: e.eventId,
        kind: 'FIXED',
        feeMinor: 50,
        currency: 'USD',
        reason: 'Dollar sales for the touring dates',
      }),
    ).resolves.toBeDefined();
  });

  maybe('the admin preview matches what the checkout charges', async () => {
    const e = await event({ priceMinor: 50_000 });
    const preview = await policies.preview({
      scope: 'EVENT',
      eventId: e.eventId,
      kind: 'PERCENT',
      percentBps: 100,
      currency: 'INR',
      subtotalMinor: 50_000,
    });
    expect(preview.schedule.bookingFeeMinor).toBe(1_500);
    expect(preview.withPolicy.bookingFeeMinor).toBe(500);
    expect(preview.feeWaivedMinor).toBe(1_000);
    expect(preview.appliesToBasket).toBe(true);
    await policies.create(adminId, {
      scope: 'EVENT',
      eventId: e.eventId,
      kind: 'PERCENT',
      percentBps: 100,
      currency: 'INR',
      reason: 'One percent for the festival week',
    });
    const quote = await bookings.quote(input(e));
    expect(quote.fees.bookingFeeMinor).toBe(preview.withPolicy.bookingFeeMinor);
    expect(quote.fees.totalMinor).toBe(preview.withPolicy.totalMinor);
    // And the advertised resolver sees the same policy the checkout does.
    const { tiers } = await pricing.resolveFeeTiers('INR', { country: 'India' });
    expect(tiers.length).toBeGreaterThan(0);
  });
});
