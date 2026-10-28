import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BookingsService } from './bookings.service';
import { AdminService } from '../admin/admin.service';
import { PlatformFeePoliciesService } from '../admin/platform-fee-policies.service';
import { RefundsService } from '../refunds/refunds.service';

/**
 * integration-real-postgres - the COMBINED platform fee (percentage + fixed per ticket) through
 * the REAL booking path, built by Nest from AppModule.
 *
 * Proves what the pure spec (pricing/combined-fee.spec.ts) cannot: that a COMBINED band stored
 * in Postgres prices quote == booking == payment, that the paid-ticket count reaches the fee
 * from the real cart, that the booking snapshots the breakdown and keeps its money after the
 * band is edited and deleted, that ORGANIZER_PAYS and free events behave, that an EVENT
 * COMBINED policy outranks an ORGANIZATION policy, and that refunds of a multi-ticket COMBINED
 * booking stay consistent (a partial refund returns tickets only; a cancellation returns
 * everything, with the fee part recorded as the platform's).
 *
 * Isolation: the COMBINED bands are scoped to a region only this suite's venue uses; the
 * national seeded INR schedule is read, never changed. Skips when no database is reachable.
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

const tag = `cpf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REGION = `Combinedland-${tag}`;
const DAY = 86_400_000;
const RS = (rupees: number) => rupees * 100;

type Booked = {
  id: string;
  fees: { bookingFeeMinor: number; totalMinor: number; platformFeeBreakdown?: unknown };
};

describe('integration-real-postgres: COMBINED platform fee on the booking path', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let mod: TestingModule | undefined;
  let available = false;
  let bookings: BookingsService;
  let admin: AdminService;
  let policies: PlatformFeePoliciesService;
  let refunds: RefundsService;
  let adminId = '';
  const orgs: string[] = [];
  let seq = 0;

  async function org(region: string | null) {
    const n = ++seq;
    const id = (
      await db!.organization.create({
        data: { name: `CPF Org ${tag} ${n}`, slug: `cpf-org-${tag}-${n}`, status: 'APPROVED' },
      })
    ).id;
    orgs.push(id);
    const venueId = (
      await db!.venue.create({
        data: {
          organizationId: id,
          name: `CPF Hall ${tag} ${n}`,
          city: 'Vijayawada',
          country: 'India',
          ...(region ? { region } : {}),
          timezone: 'Asia/Kolkata',
        },
      })
    ).id;
    return { orgId: id, venueId };
  }

  async function event(
    o: { orgId: string; venueId: string },
    prices: number[],
    opts: { isFree?: boolean; feeMode?: string } = {},
  ) {
    const n = ++seq;
    const ev = await db!.event.create({
      data: {
        organizationId: o.orgId,
        venueId: o.venueId,
        title: `CPF ${tag} ${n}`,
        slug: `cpf-${tag}-${n}`,
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
    const types: string[] = [];
    for (const [i, priceMinor] of prices.entries()) {
      const tt = await db!.ticketType.create({
        data: {
          eventSessionId: session.id,
          name: `Type ${i}`,
          priceMinor,
          currency: 'INR',
          quantityTotal: 100,
          maxPerOrder: 10,
        },
      });
      await db!.ticketInventory.create({ data: { ticketTypeId: tt.id, quantityTotal: 100 } });
      types.push(tt.id);
    }
    return { eventId: ev.id, sessionId: session.id, types, orgId: o.orgId };
  }

  const input = (e: { sessionId: string; types: string[] }, quantities: number[]) => {
    const n = ++seq;
    return {
      eventSessionId: e.sessionId,
      items: quantities
        .map((quantity, i) => ({ ticketTypeId: e.types[i], quantity }))
        .filter((i) => i.quantity > 0),
      buyerName: `Buyer ${n}`,
      buyerEmail: `buyer-${n}-${tag}@test.invalid`,
    } as never;
  };

  const book = async (i: unknown) => (await bookings.create(null, i as never)) as unknown as Booked;

  /** Confirm a booking and issue its tickets, as a captured payment would. */
  async function confirmWithTickets(bookingId: string) {
    const b = await db!.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { items: true },
    });
    await db!.booking.update({
      where: { id: bookingId },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
    const ids: string[] = [];
    for (const item of b.items) {
      for (let q = 0; q < item.quantity; q++) {
        const t = await db!.ticket.create({
          data: {
            bookingId,
            ticketTypeId: item.ticketTypeId,
            eventSessionId: b.eventSessionId,
            organizationId: b.organizationId,
            serial: `CPF-${tag}-${++seq}`,
            nonce: `n-${seq}`,
          },
        });
        ids.push(t.id);
      }
    }
    return ids;
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT "platformFeeBreakdown" FROM "Booking" LIMIT 1`;
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
    admin = mod.get(AdminService);
    policies = mod.get(PlatformFeePoliciesService);
    refunds = mod.get(RefundsService);
    adminId = (
      await db!.user.create({
        data: {
          email: `admin-${tag}@test.invalid`,
          fullName: 'CPF Admin',
          passwordHash: 'not-a-real-hash',
          roles: ['ADMIN'],
        },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const bookingWhere = { organizationId: { in: orgs } };
      const eventWhere = { event: { organizationId: { in: orgs } } };
      const steps: Array<() => Promise<unknown>> = [
        () => db!.auditLog.deleteMany({ where: { actorUserId: adminId } }),
        () => db!.refund.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.ticket.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.bookingTaxLine.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.payment.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.bookingItem.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.notification.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.booking.deleteMany({ where: bookingWhere }),
        () =>
          db!.platformFeePolicyEvent.deleteMany({
            where: { policy: { organizationId: { in: orgs } } },
          }),
        () => db!.platformFeePolicy.deleteMany({ where: { organizationId: { in: orgs } } }),
        () =>
          db!.ticketInventory.deleteMany({ where: { ticketType: { eventSession: eventWhere } } }),
        () => db!.ticketType.deleteMany({ where: { eventSession: eventWhere } }),
        () => db!.eventSession.deleteMany({ where: eventWhere }),
        () => db!.event.deleteMany({ where: { organizationId: { in: orgs } } }),
        () => db!.venue.deleteMany({ where: { organizationId: { in: orgs } } }),
        () => db!.organization.deleteMany({ where: { id: { in: orgs } } }),
        () => db!.feeRule.deleteMany({ where: { region: REGION } }),
        () => db!.user.deleteMany({ where: { id: adminId } }),
      ];
      for (const step of steps) await step().catch(() => undefined);
      await db.$disconnect();
    }
    await mod?.close();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 180_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  let bandId = '';
  let combinedOrg: { orgId: string; venueId: string };

  maybe('setup: a 3% + Rs 5 per ticket band for this region', async () => {
    combinedOrg = await org(REGION);
    const band = await admin.createFeeRule(adminId, {
      currency: 'INR',
      minMinor: 0,
      maxMinor: null,
      feeType: 'COMBINED',
      feePercentBps: 300,
      feeMinor: RS(5),
      country: 'India',
      region: REGION,
    });
    bandId = band.id;
    expect(band).toMatchObject({ feeType: 'COMBINED', feePercentBps: 300, feeMinor: 500 });
  });

  maybe('one Rs 1,000 ticket: Rs 35 platform fee; quote == booking == payment', async () => {
    const e = await event(combinedOrg, [RS(1_000)]);
    const quote = await bookings.quote(input(e, [1]));
    expect(quote.fees.bookingFeeMinor).toBe(3_500);
    const booked = await book(input(e, [1]));
    const row = await db!.booking.findUniqueOrThrow({
      where: { id: booked.id },
      include: { payment: true },
    });
    expect(row.bookingFeeMinor).toBe(3_500);
    // The payment fee is still its own line, on net + booking fee.
    expect(row.paymentFeeMinor).toBe(quote.fees.paymentFeeMinor);
    expect(row.totalMinor).toBe(quote.fees.totalMinor);
    expect(row.payment!.amountMinor).toBe(row.totalMinor);
    expect(row.platformFeeBreakdown).toEqual({
      type: 'COMBINED',
      percentBps: 300,
      fixedPerTicketMinor: 500,
      ticketCount: 1,
      percentPartMinor: 3_000,
      fixedPartMinor: 500,
      source: 'SCHEDULE',
    });
    // No policy priced it, so the policy snapshot stays empty.
    expect(row.feePolicyKind).toBeNull();
  });

  maybe('three tickets, and a mixed cart with a free ticket', async () => {
    const e = await event(combinedOrg, [RS(1_000), RS(500), 0]);
    const three = await book(input(e, [3]));
    expect(three.fees.bookingFeeMinor).toBe(9_000 + 1_500);

    // Rs 1,000 + Rs 500 + one free ticket: 3% of Rs 1,500 + 2 paid tickets x Rs 5.
    const mixedQuote = await bookings.quote(input(e, [1, 1, 1]));
    const mixed = await book(input(e, [1, 1, 1]));
    expect(mixedQuote.fees.bookingFeeMinor).toBe(4_500 + 1_000);
    expect(mixed.fees.totalMinor).toBe(mixedQuote.fees.totalMinor);
    const row = await db!.booking.findUniqueOrThrow({ where: { id: mixed.id } });
    expect(row.platformFeeBreakdown).toMatchObject({ ticketCount: 2, fixedPartMinor: 1_000 });
  });

  maybe('ORGANIZER_PAYS: the buyer pays the tickets, the organizer the combined fee', async () => {
    const e = await event(combinedOrg, [RS(1_000)], { feeMode: 'ORGANIZER_PAYS' });
    const booked = await book(input(e, [2]));
    const row = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
    expect(row.bookingFeeMinor).toBe(6_000 + 1_000);
    expect(row.customerFeeMinor).toBe(0);
    expect(row.organizerFeeMinor).toBe(row.bookingFeeMinor + row.paymentFeeMinor);
    expect(row.totalMinor).toBe(RS(2_000));
  });

  maybe('a free event pays nothing under a COMBINED band', async () => {
    const e = await event(combinedOrg, [0], { isFree: true });
    const quote = await bookings.quote(input(e, [2]));
    expect(quote.fees.bookingFeeMinor).toBe(0);
    expect(quote.fees.totalMinor).toBe(0);
  });

  maybe(
    'the booking keeps its fee and breakdown after the band is edited and deleted',
    async () => {
      const e = await event(combinedOrg, [RS(1_000)]);
      const booked = await book(input(e, [2]));
      const before = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });

      await admin.updateFeeRule(adminId, bandId, { feePercentBps: 900, feeMinor: RS(50) });
      // The edit prices the NEXT order: 9% of Rs 1,000 + Rs 50.
      expect((await bookings.quote(input(e, [1]))).fees.bookingFeeMinor).toBe(9_000 + 5_000);
      await admin.deleteFeeRule(adminId, bandId);
      // Deleted: back to the national schedule (Rs 20 on Rs 1,000).
      expect((await bookings.quote(input(e, [1]))).fees.bookingFeeMinor).toBe(RS(20));

      const after = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
      expect(after.bookingFeeMinor).toBe(before.bookingFeeMinor);
      expect(after.paymentFeeMinor).toBe(before.paymentFeeMinor);
      expect(after.totalMinor).toBe(before.totalMinor);
      expect(after.platformFeeBreakdown).toEqual(before.platformFeeBreakdown);
    },
  );

  maybe('an EVENT COMBINED policy outranks an ORGANIZATION policy', async () => {
    // A fresh organizer on the national schedule (Rs 20 on a Rs 1,000 order).
    const o = await org(null);
    const e = await event(o, [RS(1_000)]);
    await policies.create(adminId, {
      scope: 'ORGANIZATION',
      organizationId: o.orgId,
      kind: 'FIXED',
      feeMinor: RS(10),
      currency: 'INR',
      reason: 'Organizer-wide reduced fee for the test',
    });
    await policies.create(adminId, {
      scope: 'EVENT',
      eventId: e.eventId,
      kind: 'COMBINED',
      percentBps: 100,
      feeMinor: RS(2),
      currency: 'INR',
      reason: 'Event-level combined fee for the test',
    });
    // Event first: 1% of Rs 1,000 + Rs 2 = Rs 12, although the organizer policy says Rs 10.
    const quote = await bookings.quote(input(e, [1]));
    expect(quote.fees.bookingFeeMinor).toBe(1_200);
    expect((quote.fees as { feePolicyKind?: string }).feePolicyKind).toBe('COMBINED');
    const booked = await book(input(e, [1]));
    const row = await db!.booking.findUniqueOrThrow({
      where: { id: booked.id },
      include: { payment: true },
    });
    expect(row.feePolicyKind).toBe('COMBINED');
    expect(row.baseBookingFeeMinor).toBe(RS(20));
    expect(row.feeWaivedMinor).toBe(RS(20) - 1_200);
    expect(row.payment!.amountMinor).toBe(quote.fees.totalMinor);
    expect(row.platformFeeBreakdown).toMatchObject({ source: 'POLICY', ticketCount: 1 });

    // Three tickets: Rs 30 + Rs 6 = Rs 36 is MORE than the schedule's Rs 20 - so the clamp
    // prices the order by the schedule, and the policy is not recorded against it.
    const big = await bookings.quote(input(e, [3]));
    expect(big.fees.bookingFeeMinor).toBe(RS(20));
    expect((big.fees as { feePolicyKind?: string }).feePolicyKind).toBeUndefined();
  });

  maybe('refunds of a three-ticket COMBINED booking stay consistent', async () => {
    const o = await org(REGION);
    // The band above was deleted; give this place its own COMBINED band again.
    await admin.createFeeRule(adminId, {
      currency: 'INR',
      minMinor: 0,
      maxMinor: null,
      feeType: 'COMBINED',
      feePercentBps: 300,
      feeMinor: RS(5),
      country: 'India',
      region: REGION,
    });
    const e = await event(o, [RS(1_000)]);

    // A buyer hands one ticket of three back: the ticket only, the fee stays.
    const partial = await book(input(e, [3]));
    const tickets = await confirmWithTickets(partial.id);
    type RefundRow = { amountMinor: number; platformFeeRefundedMinor: number };
    const one = (await refunds.requestAsGuest({
      bookingId: partial.id,
      reason: 'Cannot attend with the third person',
      ticketIds: [tickets[0]],
    } as never)) as unknown as RefundRow;
    expect(one.amountMinor).toBe(RS(1_000));
    expect(one.platformFeeRefundedMinor).toBe(0);

    // The show is cancelled: everything comes back, and the fee part is recorded as ours.
    const whole = await book(input(e, [3]));
    await confirmWithTickets(whole.id);
    const row = await db!.booking.findUniqueOrThrow({ where: { id: whole.id } });
    expect(row.bookingFeeMinor).toBe(10_500);
    const cancelled = (await refunds.openForCancelledSession(
      whole.id,
      'Show cancelled by organizer',
    )) as unknown as RefundRow;
    expect(cancelled.amountMinor).toBe(row.totalMinor);
    expect(cancelled.platformFeeRefundedMinor).toBe(row.bookingFeeMinor + row.paymentFeeMinor);
  });
});
