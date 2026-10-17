import { AnalyticsService } from '../analytics/analytics.service';
import { PayoutsService } from './payouts.service';
import {
  Client,
  World,
  cleanWorld,
  loadDatabaseUrl,
  makeWorld,
  newClient,
  payoutsServiceFor,
  sell,
} from './payout-scoping.fixture';

/**
 * integration-real-postgres - G1: the Overview and the Finance bridge agree to the paisa.
 *
 * ── THE SYMPTOM (QA main f7f16a1, 2026-10-16, "Bengaluru Live") ────────────────────
 * Organizer > Finance > "How this matches your Overview": the buckets added to Rs 19,479.18 and
 * "After refunds and your fee" said Rs 19,409.54, Rs 69.64 apart. One more full refund of a Rs 600
 * ticket (Rs 627.30 returned) widened it by exactly Rs 27.30. Traced row by row on QA, the gap was
 * the booking and payment fees that cancellation refunds return (`platformFeeRefundedMinor`):
 * 35.26 + 20.18 + 14.20 = 69.64, then + 27.30 = 96.94. The Overview's net took whole refunds off a
 * gross that never held those fees; the buckets take off only the organizer's share. And "Cash you
 * took at the venue" (Rs 500) was two cash bookings of a cancelled show, one already handed back.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * With the REAL Overview read (`AnalyticsService.organizer`) and the REAL Finance read
 * (`PayoutsService.summary`), both columns of the bridge equal the Overview's net, exactly, after
 * each of: a full cancellation refund, a partial refund, a cancellation refund on a show still to
 * come, a cancelled cash sale, and that cash being handed back; and again once a payout is raised.
 * Every expected figure is written out by hand below, so a wrong bucket cannot cancel a wrong net.
 *
 * Fields are read loosely (`?? 0`) so this spec also runs against code from before the fix, where
 * it fails on the figures rather than on a missing type. Skips when no database.
 */
describe('integration-real-postgres: G1 Overview = sum of the Finance bridge', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;
  let analytics: AnalyticsService;
  let world: World;

  const owner = { id: 'g1-itest-owner', roles: [] } as never;
  const suffix = `g1-${Date.now()}`;

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

  type Loose = Record<string, number | string | undefined>;
  const n = (row: Loose | undefined, key: string) => Number(row?.[key] ?? 0);

  /** Both sides of the bridge, from the two real reads. */
  async function bridge() {
    const overview = (await analytics.organizer(owner, world.orgA)).revenue?.find(
      (r) => r.currency === 'INR',
    ) as unknown as Loose;
    const ledger = (await payouts.summary(owner, world.orgA)).currencies.find(
      (c) => c.currency === 'INR',
    ) as unknown as Loose;
    return {
      net: n(overview, 'netMinor'),
      // The left column: what the Overview took off its gross.
      left:
        n(overview, 'grossMinor') -
        n(overview, 'refundedSalesMinor') -
        n(overview, 'cashGivenBackMinor') -
        n(overview, 'organizerFeesMinor'),
      // The right column: where that money is now.
      right:
        n(ledger, 'held') +
        n(ledger, 'net') +
        n(ledger, 'pending') +
        n(ledger, 'paid') +
        n(ledger, 'cancelled') +
        n(ledger, 'cash') +
        n(ledger, 'cashToReturn') -
        n(ledger, 'feeNotDeducted'),
      overview,
      ledger,
    };
  }

  async function expectIdentity(expectedNet: number) {
    const b = await bridge();
    expect(b.net).toBe(expectedNet);
    expect(b.left).toBe(expectedNet);
    expect(b.right).toBe(expectedNet);
    return b;
  }

  /** A sale whose buyer also paid booking and payment fees on top of the ticket. */
  async function sellWithFees(
    eventId: string,
    subtotalMinor: number,
    buyerFeesMinor: number,
    organizerFeeMinor = 0,
  ) {
    const b = await sell(db!, world, world.orgA, eventId, { subtotalMinor, organizerFeeMinor });
    return db!.booking.update({
      where: { id: b.id },
      data: { bookingFeeMinor: buyerFeesMinor, totalMinor: subtotalMinor + buyerFeesMinor },
    });
  }

  /** A completed refund as `RefundsService` writes it: a cancellation also returns the fees. */
  async function refund(
    bookingId: string,
    amountMinor: number,
    platformFeeRefundedMinor: number,
    bookingStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED',
  ) {
    await db!.refund.create({
      data: {
        bookingId,
        organizationId: world.orgA,
        amountMinor,
        platformFeeRefundedMinor,
        status: 'COMPLETED',
        reason: 'g1-itest',
      },
    });
    await db!.booking.update({ where: { id: bookingId }, data: { status: bookingStatus } });
  }

  /** Cash taken at the counter: the booking is confirmed when the cash is collected. */
  async function cashSale(eventId: string, subtotalMinor: number, organizerFeeMinor = 0) {
    const b = await sellWithFees(eventId, subtotalMinor, 0, organizerFeeMinor);
    return db!.booking.update({
      where: { id: b.id },
      data: { paymentMethod: 'CASH', cashCollectedAt: new Date() },
    });
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = newClient(url);
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    payouts = payoutsServiceFor(db);
    analytics = new AnalyticsService(
      db as never,
      { assertMember: async () => undefined } as never,
      {} as never,
    );
    // The owner's membership is what shows money; the fixture organization has no members.
    jest
      .spyOn(
        analytics as unknown as { canViewFinancials: () => Promise<boolean> },
        'canViewFinancials',
      )
      .mockResolvedValue(true);
    world = await makeWorld(db, suffix);
    // a2 is the cancelled show, as on QA.
    await db.event.update({ where: { id: world.a2 }, data: { status: 'CANCELLED' } });
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await cleanWorld(db, world);
    await db.$disconnect();
  }, 60_000);

  // Sold, nothing given back yet. a1 finished (ready), aLive still to come (held), a2 cancelled.
  it('balances before anything is refunded', async () => {
    if (!guard()) return;
    await sell(db!, world, world.orgA, world.a1, {
      subtotalMinor: 91_300,
      organizerFeeMinor: 2_700,
    });
    await sell(db!, world, world.orgA, world.aLive, {
      subtotalMinor: 18_600,
      organizerFeeMinor: 1_150,
    });
    await sellWithFees(world.a2, 41_700, 1_960);
    await cashSale(world.aLive, 6_450);
    // 158 050 sold - 3 850 fees.
    const b = await expectIdentity(154_200);
    expect(n(b.ledger, 'cash')).toBe(6_450);
  });

  it('balances after a full refund that also returns the buyer fees', async () => {
    if (!guard()) return;
    // The QA case: a Rs 600 ticket, Rs 627.30 returned, Rs 27.30 of it booking and payment fees.
    const x = await sellWithFees(world.a2, 60_000, 2_730);
    await refund(x.id, 62_730, 2_730, 'REFUNDED');
    // The ticket money comes off; the fees were never in gross. 218 050 - 3 850 - 60 000.
    const b = await expectIdentity(154_200);
    expect(n(b.overview, 'refundedSalesMinor')).toBe(60_000);
    expect(n(b.overview, 'refundedOutsideSalesMinor')).toBe(2_730);
    expect(n(b.ledger, 'cancelled')).toBe(41_700);
  });

  it('balances after a partial refund, and a cancellation refund on a show still to come', async () => {
    if (!guard()) return;
    const p = await sellWithFees(world.aLive, 40_000, 1_400);
    await refund(p.id, 20_000, 0, 'PARTIALLY_REFUNDED');
    // A cancelled date of a show that goes on: its refund returns fees too, inside `held`.
    const s = await sellWithFees(world.aLive, 15_000, 700);
    await refund(s.id, 15_700, 700, 'REFUNDED');
    // 273 050 sold - 3 850 fees - 95 000 ticket money refunded.
    const b = await expectIdentity(174_200);
    // 18 600 + 40 000 + 15 000 - 20 000 - 15 000: no fee comes off held.
    expect(n(b.ledger, 'held')).toBe(38_600);
  });

  it('counts a cancelled cash sale as cash to give back, not as cash taken', async () => {
    if (!guard()) return;
    const c = await cashSale(world.a2, 20_000, 400);
    await db!.booking.update({
      where: { id: c.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    // Still in gross, and the organizer holds it until handed back: 293 050 - 4 250 - 95 000.
    const b = await expectIdentity(193_800);
    expect(n(b.ledger, 'cash')).toBe(6_450);
    expect(n(b.ledger, 'cashToReturn')).toBe(20_000);
  });

  it('takes cash handed back off the Overview and out of every bucket', async () => {
    if (!guard()) return;
    const r = await cashSale(world.a2, 30_000, 500);
    await db!.booking.update({
      where: { id: r.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    // What `CashReturnsService.markReturned` records: an offline return, no Refund row.
    await db!.booking.update({ where: { id: r.id }, data: { cashReturnedAt: new Date() } });
    // 323 050 sold - 4 750 fees - 95 000 refunded - 30 000 handed back.
    const b = await expectIdentity(193_300);
    expect(n(b.overview, 'cashGivenBackMinor')).toBe(30_000);
    expect(n(b.ledger, 'cash')).toBe(6_450);
    expect(n(b.ledger, 'cashToReturn')).toBe(20_000);
    // The fee on cash is not off any bucket yet: 1 150 held + 400 + 500 on the cash sales.
    expect(n(b.ledger, 'feeNotDeducted')).toBe(2_050);
  });

  it('still balances once a payout is raised', async () => {
    if (!guard()) return;
    const created = await payouts.generate(owner, world.orgA);
    expect(created).toHaveLength(1);
    const b = await expectIdentity(193_300);
    expect(n(b.ledger, 'pending')).toBe(91_300 - 2_700);
    expect(n(b.ledger, 'net')).toBe(0);
  });
});
