import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PayoutsService } from './payouts.service';

/**
 * integration-real-postgres — a payout's allocations account for it EXACTLY.
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ─────────────────────────────────────────────────
 * The unit tests hold the generator to the shape of its allocations against an in-memory ledger,
 * and the pure property test holds the arithmetic over 300 random populations. Neither can prove
 * the thing that actually matters in production: that the rows COMMITTED next to a payout add
 * back to the payout's own committed total.
 *
 * Everything here is read back out of Postgres after the transaction closed. An assertion against
 * the object the service returned would prove only that the service agrees with itself.
 *
 *   SUM(PayoutAllocation.allocatedNetMinor) = Payout.netMinor
 *
 * Integer minor units on both sides, so there is nothing to round and no tolerance to justify.
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

describe('integration-real-postgres: payout allocations account for the payout', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;

  const suffix = `alloc-${Date.now()}`;
  const owner = { id: 'alloc-itest-owner', roles: [] } as never;
  /*
    One organization PER TEST, not one for the suite.

    The open-payout guard refuses a second payout while one is still PENDING in the same scope,
    which is correct - and it means a shared organization would make every test after the first
    fail on the guard rather than on what it was meant to prove. Learned the hard way: the first
    run of this suite reported six failures that were all this.
  */
  let orgId = '';
  const orgIds: string[] = [];
  const eventIds: string[] = [];

  async function freshOrg(label: string): Promise<void> {
    const org = await db!.organization.create({
      data: { name: `Alloc ${label} ${suffix}`, slug: `alloc-${label}-${suffix}` },
    });
    orgId = org.id;
    orgIds.push(org.id);
  }

  /** A finished event, because revenue is only payable once the show is over. */
  async function makeEvent(label: string): Promise<{ eventId: string; sessionId: string }> {
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `V ${label} ${suffix}`,
        city: 'Bengaluru',
        country: 'India',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `${label} ${suffix}`,
        slug: `${label}-${suffix}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    const session = await db!.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: new Date(Date.now() - 90_000_000),
        endsAt: new Date(Date.now() - 86_400_000),
        status: 'COMPLETED',
      },
    });
    eventIds.push(event.id);
    return { eventId: event.id, sessionId: session.id };
  }

  async function sell(
    where: { eventId: string; sessionId: string },
    money: {
      currency: string;
      subtotalMinor: number;
      discountMinor?: number;
      organizerFeeMinor?: number;
      bookingFeeMinor?: number;
      paymentFeeMinor?: number;
    },
  ): Promise<{ id: string }> {
    return db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: where.eventId,
        eventSessionId: where.sessionId,
        buyerName: 'Asha Rao',
        buyerEmail: `asha+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: 'ONLINE',
        currency: money.currency,
        feeMode: 'CUSTOMER_PAYS',
        subtotalMinor: money.subtotalMinor,
        discountMinor: money.discountMinor ?? 0,
        bookingFeeMinor: money.bookingFeeMinor ?? 0,
        paymentFeeMinor: money.paymentFeeMinor ?? 0,
        organizerFeeMinor: money.organizerFeeMinor ?? 0,
        customerFeeMinor: 0,
        taxMinor: 0,
        totalMinor: money.subtotalMinor,
        holdExpiresAt: new Date(Date.now() - 120_000),
        confirmedAt: new Date(),
      },
      select: { id: true },
    });
  }

  async function refundFully(bookingId: string, amountMinor: number, taxAddedMinor = 0) {
    await db!.refund.create({
      data: {
        bookingId,
        organizationId: orgId,
        amountMinor,
        taxAddedMinor,
        status: 'COMPLETED',
        reason: 'integration test',
      },
    });
  }

  /** Every figure read back from Postgres, never from the service's return value. */
  async function committed(payoutId: string) {
    const payout = await db!.payout.findUnique({
      where: { id: payoutId },
      select: { netMinor: true, currency: true, eventId: true, allocatedFrom: true },
    });
    const rows = await db!.payoutAllocation.findMany({ where: { payoutId } });
    return {
      payout: payout!,
      rows: rows as Array<Record<string, number & string>>,
      allocated: rows.reduce(
        (total: number, row: { allocatedNetMinor: number }) => total + row.allocatedNetMinor,
        0,
      ),
    };
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    payouts = new PayoutsService(
      db as never,
      { assertMember: async () => undefined } as never,
      { record: async () => undefined } as never,
      // No hold and no minimum: this suite is about the allocation sum, not eligibility.
      {
        effectiveFor: async () => ({
          holdDays: 0,
          minPayoutMinor: {},
          source: { holdDays: 'default', minPayoutMinor: 'default' },
        }),
      } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    const mine = await db.payout.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    for (const p of mine) {
      await db.payoutAllocation.deleteMany({ where: { payoutId: p.id } }).catch(() => {});
    }
    await db.payout.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.refund.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.eventSession.deleteMany({ where: { eventId: { in: eventIds } } }).catch(() => {});
    await db.event.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped — DB unavailable');
      return false;
    }
    return true;
  };

  it('commits allocations that add back to the committed net, exactly', async () => {
    if (!guard()) return;
    await freshOrg('exact');
    const a = await makeEvent('gig-a');
    const b = await makeEvent('gig-b');
    const sold = [
      await sell(a, {
        currency: 'INR',
        subtotalMinor: 150_000,
        discountMinor: 10_000,
        organizerFeeMinor: 7_500,
      }),
      await sell(a, {
        currency: 'INR',
        subtotalMinor: 99_999,
        organizerFeeMinor: 4_999,
        bookingFeeMinor: 1,
      }),
      // A discount larger than its own subtotal is a real data state, not a contrived one.
      await sell(b, { currency: 'INR', subtotalMinor: 40_000, discountMinor: 50_000 }),
      await sell(b, { currency: 'INR', subtotalMinor: 0 }),
    ];

    const [raised] = await payouts.generate(owner, orgId);
    const { payout, rows, allocated } = await committed(raised.id);

    expect(rows.length).toBe(sold.length);
    // THE invariant. Labelled so a failure prints both numbers rather than "a !== b".
    expect(`allocated=${allocated}`).toBe(`allocated=${payout.netMinor}`);
    // And it is not vacuously true against an all-zero payout.
    expect(payout.netMinor).not.toBe(0);
  });

  it('names exactly the bookings the payout was built from', async () => {
    if (!guard()) return;
    await freshOrg('membership');
    const e = await makeEvent('membership');
    const mine = [
      await sell(e, { currency: 'INR', subtotalMinor: 12_000 }),
      await sell(e, { currency: 'INR', subtotalMinor: 34_000 }),
    ];
    // A cash booking: its money is already in the organizer's till, so it is not payable and
    // must not appear in the explanation either.
    await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: e.eventId,
        eventSessionId: e.sessionId,
        buyerName: 'Cash Buyer',
        buyerEmail: `cash+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: 'CASH',
        currency: 'INR',
        feeMode: 'CUSTOMER_PAYS',
        subtotalMinor: 99_000,
        discountMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        organizerFeeMinor: 0,
        customerFeeMinor: 0,
        taxMinor: 0,
        totalMinor: 99_000,
        holdExpiresAt: new Date(Date.now() - 120_000),
        confirmedAt: new Date(),
      },
    });

    const [raised] = await payouts.generate(owner, orgId);
    const { rows, payout, allocated } = await committed(raised.id);

    expect(rows.map((r) => r.bookingId).sort()).toEqual(mine.map((m) => m.id).sort());
    expect(allocated).toBe(payout.netMinor);
  });

  it('records which events a PERIOD payout covers, which its own eventId cannot', async () => {
    if (!guard()) return;
    await freshOrg('period');
    const a = await makeEvent('period-a');
    const b = await makeEvent('period-b');
    await sell(a, { currency: 'INR', subtotalMinor: 10_000 });
    await sell(b, { currency: 'INR', subtotalMinor: 20_000 });

    const [raised] = await payouts.generate(owner, orgId);
    const { payout, rows } = await committed(raised.id);

    // The gap this closes: an org-wide payout names no event.
    expect(payout.eventId).toBeNull();
    expect([...new Set(rows.map((r) => r.eventId))].sort()).toEqual([a.eventId, b.eventId].sort());
    expect(payout.allocatedFrom).not.toBeNull();
  });

  it('attributes a refund to the booking it returns', async () => {
    if (!guard()) return;
    await freshOrg('refunded');
    const e = await makeEvent('refunded');
    const refunded = await sell(e, { currency: 'INR', subtotalMinor: 50_000 });
    const untouched = await sell(e, { currency: 'INR', subtotalMinor: 30_000 });
    // Tax ADDED on top was the platform's to remit, so only 9 200 is the organizer's.
    await refundFully(refunded.id, 10_000, 800);

    const [raised] = await payouts.generate(owner, orgId);
    const { payout, rows, allocated } = await committed(raised.id);

    const hit = rows.find((r) => r.bookingId === refunded.id)!;
    expect(hit.refundShareMinor).toBe(9_200);
    expect(hit.allocatedNetMinor).toBe(50_000 - 9_200);
    // Not smeared across the other booking.
    expect(rows.find((r) => r.bookingId === untouched.id)!.refundShareMinor).toBe(0);
    expect(allocated).toBe(payout.netMinor);
  });

  it('allocates a clawback for a booking outside the payout revenue window', async () => {
    if (!guard()) return;
    /*
      The windows differ by design - revenue on confirmedAt, refunds on updatedAt - so a payout
      can deduct a refund for a booking its own revenue query never returned. If that clawback
      were not allocated, the sum would not account for the net and the payout would be refused.
    */
    await freshOrg('clawback');
    const e = await makeEvent('clawback');
    const sold = await sell(e, { currency: 'INR', subtotalMinor: 60_000 });
    const [first] = await payouts.generate(owner, orgId);
    await payouts.markPaid(owner, first.id);

    await refundFully(sold.id, 15_000);
    const [second] = await payouts.generate(owner, orgId);
    const { payout, rows, allocated } = await committed(second.id);

    expect(payout.netMinor).toBe(-15_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookingId: sold.id,
      subtotalMinor: 0,
      refundShareMinor: 15_000,
      allocatedNetMinor: -15_000,
    });
    expect(allocated).toBe(payout.netMinor);

    // The same booking is now explained by two payouts, which is correct and is why the unique
    // key is (payoutId, bookingId).
    const claims = await db!.payoutAllocation.findMany({ where: { bookingId: sold.id } });
    expect(claims).toHaveLength(2);
  });

  it('keeps each currency to its own payout and its own allocations', async () => {
    if (!guard()) return;
    await freshOrg('multi-ccy');
    const e = await makeEvent('multi-ccy');
    await sell(e, { currency: 'INR', subtotalMinor: 10_000 });
    await sell(e, { currency: 'USD', subtotalMinor: 20_000 });
    await sell(e, { currency: 'CAD', subtotalMinor: 7 });

    const raised = await payouts.generate(owner, orgId);
    expect(raised).toHaveLength(3);
    for (const one of raised) {
      const { payout, rows, allocated } = await committed(one.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.currency === payout.currency)).toBe(true);
      expect(`${payout.currency}=${allocated}`).toBe(`${payout.currency}=${payout.netMinor}`);
    }
  });

  it('leaves no payout without allocations when several generates race', async () => {
    if (!guard()) return;
    /*
      The advisory lock is already proven to admit exactly one generate. What matters here is
      that the winner's allocations are COMPLETE: payout and allocations are written in one
      transaction, so there is no committed payout with a partial explanation.
    */
    await freshOrg('race');
    const e = await makeEvent('race');
    await sell(e, { currency: 'INR', subtotalMinor: 25_000 });
    await sell(e, { currency: 'INR', subtotalMinor: 35_000 });

    const attempts = await Promise.allSettled([
      payouts.generate(owner, orgId),
      payouts.generate(owner, orgId),
      payouts.generate(owner, orgId),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    const everyPayout = await db!.payout.findMany({
      where: { organizationId: orgId, allocatedFrom: { not: null } },
      select: { id: true, netMinor: true, currency: true },
    });
    for (const p of everyPayout) {
      const { allocated, rows } = await committed(p.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(`${p.id} ${p.currency}=${allocated}`).toBe(`${p.id} ${p.currency}=${p.netMinor}`);
    }
  });

  it('holds the invariant across every payout this suite created', async () => {
    if (!guard()) return;
    /*
      A final sweep rather than a per-test check only. If any earlier test left a payout whose
      allocations do not account for it, this fails and names it - which is the state a
      reconciliation job would later have to explain.
    */
    const all = await db!.payout.findMany({
      where: { organizationId: { in: orgIds }, allocatedFrom: { not: null } },
      select: { id: true, netMinor: true },
    });
    expect(all.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const p of all) {
      const { allocated } = await committed(p.id);
      if (allocated !== p.netMinor) {
        broken.push(`${p.id}: net=${p.netMinor} allocated=${allocated}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
