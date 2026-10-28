import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BookingsService } from './bookings.service';
import { AdminService } from '../admin/admin.service';
import { PlatformFeePoliciesService } from '../admin/platform-fee-policies.service';
import { RefundsService } from '../refunds/refunds.service';

/**
 * integration-real-postgres - owner fee decisions 2026-10-29 through the REAL booking and
 * admin paths, built by Nest from AppModule:
 *
 *  - FIXED_PER_TICKET (fixed amount x paid tickets) prices quote == booking == payment, from
 *    the real cart, in INR and USD, and a free ticket in a mixed cart is not charged;
 *  - the optional minimum / maximum hold the whole-order fee and the snapshot says so;
 *  - the legacy FLAT schedule still charges once per order (regression);
 *  - an EVENT FIXED_PER_TICKET policy outranks an ORGANIZATION policy, and the clamp prices an
 *    order by the schedule when the policy would charge more;
 *  - the booking keeps its money and snapshot after the band is edited and deleted;
 *  - refunds of a FIXED_PER_TICKET booking stay consistent;
 *  - switching a band off (or narrowing it) is refused with 409 exactly as a delete is.
 *
 * Isolation: the per-ticket bands are scoped to regions only this suite's venues use; the
 * coverage cases use the ISO codes XTS, XXX and XBA, which no venue sells in. The
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

const tag = `fpt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REGION = `Perticketland-${tag}`;
const US_REGION = `Perticket-US-${tag}`;
const DAY = 86_400_000;
const RS = (rupees: number) => rupees * 100;

type Booked = {
  id: string;
  fees: { bookingFeeMinor: number; totalMinor: number; platformFeeBreakdown?: unknown };
};

describe('integration-real-postgres: FIXED_PER_TICKET fees, limits and band coverage', () => {
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

  async function org(place: { country: string; region: string | null; tz?: string }) {
    const n = ++seq;
    const id = (
      await db!.organization.create({
        data: { name: `FPT Org ${tag} ${n}`, slug: `fpt-org-${tag}-${n}`, status: 'APPROVED' },
      })
    ).id;
    orgs.push(id);
    const venueId = (
      await db!.venue.create({
        data: {
          organizationId: id,
          name: `FPT Hall ${tag} ${n}`,
          city: 'Vijayawada',
          country: place.country,
          ...(place.region ? { region: place.region } : {}),
          timezone: place.tz ?? 'Asia/Kolkata',
        },
      })
    ).id;
    return { orgId: id, venueId };
  }

  async function event(
    o: { orgId: string; venueId: string },
    prices: number[],
    opts: { currency?: string } = {},
  ) {
    const n = ++seq;
    const ev = await db!.event.create({
      data: {
        organizationId: o.orgId,
        venueId: o.venueId,
        title: `FPT ${tag} ${n}`,
        slug: `fpt-${tag}-${n}`,
        category: 'Music',
        status: 'PUBLISHED',
        isFree: false,
        feeMode: 'CUSTOMER_PAYS' as never,
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
          currency: opts.currency ?? 'INR',
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

  /** quote == booking == payment, and the booking row as stored. */
  async function bookAndCompare(i: unknown) {
    const quote = await bookings.quote(i as never);
    const booked = await book(i);
    const row = await db!.booking.findUniqueOrThrow({
      where: { id: booked.id },
      include: { payment: true },
    });
    expect(row.bookingFeeMinor).toBe(quote.fees.bookingFeeMinor);
    expect(row.paymentFeeMinor).toBe(quote.fees.paymentFeeMinor);
    expect(row.totalMinor).toBe(quote.fees.totalMinor);
    expect(booked.fees.totalMinor).toBe(quote.fees.totalMinor);
    expect(row.payment!.amountMinor).toBe(row.totalMinor);
    return { quote, row };
  }

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
            serial: `FPT-${tag}-${++seq}`,
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
      // The suite needs the FIXED_PER_TICKET enum value (migration 20261029120000).
      await db!.$queryRaw`SELECT 'FIXED_PER_TICKET'::"FeeRuleType"`;
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
          fullName: 'FPT Admin',
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
        () =>
          db!.feeRule.deleteMany({
            where: {
              OR: [
                { region: { in: [REGION, US_REGION] } },
                { currency: { in: ['XTS', 'XXX', 'XBA'] } },
              ],
            },
          }),
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
  let perTicketOrg: { orgId: string; venueId: string };

  maybe('setup: a Rs 5 per ticket band for this region', async () => {
    perTicketOrg = await org({ country: 'India', region: REGION });
    const band = await admin.createFeeRule(adminId, {
      currency: 'INR',
      minMinor: 0,
      maxMinor: null,
      feeType: 'FIXED_PER_TICKET',
      feeMinor: RS(5),
      country: 'India',
      region: REGION,
    });
    bandId = band.id;
    expect(band).toMatchObject({
      feeType: 'FIXED_PER_TICKET',
      feeMinor: 500,
      feePercentBps: null,
      minFeeMinor: null,
      maxFeeMinor: null,
    });
  });

  maybe('one ticket: Rs 5; quote == booking == payment; snapshot', async () => {
    const e = await event(perTicketOrg, [RS(1_000)]);
    const { row } = await bookAndCompare(input(e, [1]));
    expect(row.bookingFeeMinor).toBe(RS(5));
    expect(row.platformFeeBreakdown).toEqual({
      type: 'FIXED_PER_TICKET',
      percentBps: 0,
      fixedPerTicketMinor: 500,
      ticketCount: 1,
      percentPartMinor: 0,
      fixedPartMinor: 500,
      source: 'SCHEDULE',
    });
  });

  maybe('three tickets: Rs 15; a mixed cart with a free ticket pays for two', async () => {
    const e = await event(perTicketOrg, [RS(1_000), RS(500), 0]);
    const three = await bookAndCompare(input(e, [3]));
    expect(three.row.bookingFeeMinor).toBe(RS(15));
    const mixed = await bookAndCompare(input(e, [1, 1, 1]));
    expect(mixed.row.bookingFeeMinor).toBe(RS(10));
    expect(mixed.row.platformFeeBreakdown).toMatchObject({ ticketCount: 2, fixedPartMinor: 1_000 });
  });

  maybe('USD: $1.50 per ticket on a US venue is charged in cents', async () => {
    const us = await org({ country: 'United States', region: US_REGION, tz: 'America/New_York' });
    await admin.createFeeRule(adminId, {
      currency: 'USD',
      minMinor: 0,
      maxMinor: null,
      feeType: 'FIXED_PER_TICKET',
      feeMinor: 150,
      country: 'United States',
      region: US_REGION,
    });
    const e = await event(us, [2_500], { currency: 'USD' });
    const quote = await bookings.quote(input(e, [4]));
    expect(quote.fees.bookingFeeMinor).toBe(600);
    expect(quote.fees.platformFeeBreakdown).toMatchObject({
      type: 'FIXED_PER_TICKET',
      ticketCount: 4,
    });
  });

  maybe('legacy FLAT schedule still charges once per order (regression)', async () => {
    // A venue with no region: the seeded national INR schedule, Rs 20 for Rs 1,000 and above.
    const o = await org({ country: 'India', region: null });
    const e = await event(o, [RS(1_000)]);
    const { row } = await bookAndCompare(input(e, [3]));
    expect(row.bookingFeeMinor).toBe(RS(20));
    expect(row.platformFeeBreakdown).toBeNull();
  });

  maybe('a minimum, then a maximum, hold the whole-order fee; the snapshot says so', async () => {
    const e = await event(perTicketOrg, [RS(1_000)]);

    await admin.updateFeeRule(adminId, bandId, { minFeeMinor: RS(12) });
    const low = await bookAndCompare(input(e, [1]));
    expect(low.row.bookingFeeMinor).toBe(RS(12));
    expect(low.row.platformFeeBreakdown).toMatchObject({
      fixedPartMinor: RS(5),
      minFeeMinor: RS(12),
      maxFeeMinor: null,
      limitApplied: 'MIN',
    });

    await admin.updateFeeRule(adminId, bandId, { minFeeMinor: null, maxFeeMinor: RS(30) });
    const high = await bookAndCompare(input(e, [8]));
    expect(high.row.bookingFeeMinor).toBe(RS(30));
    expect(high.row.platformFeeBreakdown).toMatchObject({
      fixedPartMinor: RS(40),
      limitApplied: 'MAX',
    });

    // Back to unset: no limit fields at all, the fee is the parts again.
    await admin.updateFeeRule(adminId, bandId, { maxFeeMinor: null });
    const plain = await bookAndCompare(input(e, [8]));
    expect(plain.row.bookingFeeMinor).toBe(RS(40));
    expect(plain.row.platformFeeBreakdown).not.toHaveProperty('limitApplied');

    // A minimum above the maximum is refused and nothing changes.
    await expect(
      admin.updateFeeRule(adminId, bandId, { minFeeMinor: RS(50), maxFeeMinor: RS(10) }),
    ).rejects.toThrow(/minimum fee cannot be more than the maximum/);
  });

  maybe('an EVENT per-ticket policy outranks an ORGANIZATION policy; clamp', async () => {
    const o = await org({ country: 'India', region: null });
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
      kind: 'FIXED_PER_TICKET',
      feeMinor: RS(3),
      currency: 'INR',
      reason: 'Event-level per-ticket fee for the test',
    });
    // Event first: 3 tickets x Rs 3 = Rs 9, although the organizer policy says Rs 10.
    const { quote, row } = await bookAndCompare(input(e, [3]));
    expect(quote.fees.bookingFeeMinor).toBe(RS(9));
    expect(row.feePolicyKind).toBe('FIXED_PER_TICKET');
    expect(row.baseBookingFeeMinor).toBe(RS(20));
    expect(row.feeWaivedMinor).toBe(RS(11));
    expect(row.platformFeeBreakdown).toMatchObject({ source: 'POLICY', ticketCount: 3 });

    // Ten tickets: Rs 30 is MORE than the schedule's Rs 20, so the schedule prices the order
    // and the policy is not recorded against it.
    const big = await bookings.quote(input(e, [10]));
    expect(big.fees.bookingFeeMinor).toBe(RS(20));
    expect((big.fees as { feePolicyKind?: string }).feePolicyKind).toBeUndefined();
  });

  maybe('the booking keeps its fee and snapshot after the band is edited and deleted', async () => {
    const e = await event(perTicketOrg, [RS(1_000)]);
    const booked = await book(input(e, [2]));
    const before = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
    expect(before.bookingFeeMinor).toBe(RS(10));

    await admin.updateFeeRule(adminId, bandId, { feeMinor: RS(50), maxFeeMinor: RS(60) });
    expect((await bookings.quote(input(e, [2]))).fees.bookingFeeMinor).toBe(RS(60));
    await admin.deleteFeeRule(adminId, bandId);
    // Deleted: back to the national schedule (Rs 20 on Rs 2,000).
    expect((await bookings.quote(input(e, [2]))).fees.bookingFeeMinor).toBe(RS(20));

    const after = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
    expect(after.bookingFeeMinor).toBe(before.bookingFeeMinor);
    expect(after.paymentFeeMinor).toBe(before.paymentFeeMinor);
    expect(after.totalMinor).toBe(before.totalMinor);
    expect(after.platformFeeBreakdown).toEqual(before.platformFeeBreakdown);
  });

  maybe('refunds of a three-ticket FIXED_PER_TICKET booking stay consistent', async () => {
    const o = await org({ country: 'India', region: REGION });
    // The band above was deleted; give this place its own per-ticket band again.
    await admin.createFeeRule(adminId, {
      currency: 'INR',
      minMinor: 0,
      maxMinor: null,
      feeType: 'FIXED_PER_TICKET',
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
    // The snapshot is not recomputed by a refund.
    const partialRow = await db!.booking.findUniqueOrThrow({ where: { id: partial.id } });
    expect(partialRow.bookingFeeMinor).toBe(RS(15));
    expect(partialRow.platformFeeBreakdown).toMatchObject({ ticketCount: 3 });

    // The show is cancelled: everything comes back, and the fee part is recorded as ours.
    const whole = await book(input(e, [3]));
    await confirmWithTickets(whole.id);
    const row = await db!.booking.findUniqueOrThrow({ where: { id: whole.id } });
    expect(row.bookingFeeMinor).toBe(RS(15));
    const cancelled = (await refunds.openForCancelledSession(
      whole.id,
      'Show cancelled by organizer',
    )) as unknown as RefundRow;
    expect(cancelled.amountMinor).toBe(row.totalMinor);
    expect(cancelled.platformFeeRefundedMinor).toBe(row.bookingFeeMinor + row.paymentFeeMinor);
  });

  describe('switching a band off is checked like a delete (409)', () => {
    const status = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (err) {
        return err as { getStatus(): number; details?: { reason?: string }; message: string };
      }
    };

    maybe('refuses switching off or narrowing a band that opens a gap; row unchanged', async () => {
      const low = await admin.createFeeRule(adminId, {
        currency: 'XTS',
        minMinor: 0,
        maxMinor: 49_999,
        feeMinor: 100,
      });
      const high = await admin.createFeeRule(adminId, {
        currency: 'XTS',
        minMinor: 50_000,
        maxMinor: null,
        feeMinor: 200,
      });

      const off = await status(admin.updateFeeRule(adminId, high.id, { active: false }));
      expect(off?.getStatus()).toBe(409);
      expect(off?.details?.reason).toBe('GAP');
      expect(off?.message).toMatch(/^Switching off "/);

      const narrow = await status(admin.updateFeeRule(adminId, low.id, { maxMinor: 10_000 }));
      expect(narrow?.getStatus()).toBe(409);
      expect(narrow?.details?.reason).toBe('GAP');

      const stored = await db!.feeRule.findUniqueOrThrow({ where: { id: high.id } });
      expect(stored.active).toBe(true);
      expect((await db!.feeRule.findUniqueOrThrow({ where: { id: low.id } })).maxMinor).toBe(
        49_999,
      );

      // The delete is refused for the same reason, in the same words.
      const del = await status(admin.deleteFeeRule(adminId, high.id));
      expect(del?.getStatus()).toBe(409);
      expect(del?.details?.reason).toBe('GAP');
    });

    maybe('refuses switching off the last band of a currency (no band left)', async () => {
      const only = await admin.createFeeRule(adminId, {
        currency: 'XXX',
        minMinor: 0,
        maxMinor: null,
        feeMinor: 100,
      });
      const err = await status(admin.updateFeeRule(adminId, only.id, { active: false }));
      expect(err?.getStatus()).toBe(409);
      expect(err?.details?.reason).toBe('NO_BAND_LEFT');
      expect((await db!.feeRule.findUniqueOrThrow({ where: { id: only.id } })).active).toBe(true);
    });

    maybe('an inactive band can always be edited; an existing gap does not block', async () => {
      const off = await admin.createFeeRule(adminId, {
        currency: 'XXX',
        minMinor: 0,
        maxMinor: 10,
        feeMinor: 1,
        country: 'India',
        region: REGION,
        active: false,
      });
      await expect(
        admin.updateFeeRule(adminId, off.id, { maxMinor: 5, feeMinor: 2 }),
      ).resolves.toMatchObject({ maxMinor: 5, feeMinor: 2, active: false });

      // A schedule that already has a hole (1,000 - 4,999 is covered by nothing): changing
      // the fee of a band beside it is not blocked by that hole.
      const a = await admin.createFeeRule(adminId, {
        currency: 'XBA',
        minMinor: 0,
        maxMinor: 999,
        feeMinor: 1,
      });
      await admin.createFeeRule(adminId, {
        currency: 'XBA',
        minMinor: 5_000,
        maxMinor: null,
        feeMinor: 1,
      });
      await expect(admin.updateFeeRule(adminId, a.id, { feeMinor: 7 })).resolves.toMatchObject({
        feeMinor: 7,
      });
    });
  });
});
