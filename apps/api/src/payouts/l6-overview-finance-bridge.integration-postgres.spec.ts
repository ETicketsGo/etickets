import { UnifiedFinanceService } from '../finance/unified-finance.service';
import { PayoutsService } from './payouts.service';
import {
  Client,
  World,
  claimWithProvider,
  cleanWorld,
  loadDatabaseUrl,
  makeWorld,
  newClient,
  payoutsServiceFor,
  refund,
  sell,
} from './payout-scoping.fixture';

/**
 * integration-real-postgres - L6: the Overview and Finance must explain each other.
 *
 * ── THE SYMPTOM (QA 2026-10-16, seed organizer "Bengaluru Live") ───────────────────
 * Overview: gross sales Rs 23,281. Finance: held 8,292 + ready 6,989.18 + in a payout 1,598, then
 * "Settled by your payment provider" Rs 14,040.87 and "Needs attention: An event appears in two
 * payment routes at once". Traced row by row:
 *   - the 14,040.87 was 14 settlement rows in HELD/ELIGIBLE with no payment account - the SAME
 *     events as held and ready, shown a second time as "not part of the figures above";
 *   - the warning was a payout beside one of those unmoved settlements, which is the designed state;
 *   - after refunds (5,346) and the platform fee (55.82) the Overview's money is 17,879.18, and the
 *     ledger's buckets add to 16,879.18. The Rs 1,000 left over is an online sale of a CANCELLED
 *     event ("K-TEST Neon Nights Live"), which no ledger figure reports.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * With the Overview's own definition of sales (confirmed bookings' subtotal, less completed
 * refunds and the organizer fee), every rupee is in exactly one figure on Finance: held, ready,
 * in a payout, paid, sales of cancelled events, or cash at the venue. And a provider route is
 * shown only for money a transfer has claimed, which the ledger leaves out.
 *
 * Amounts are asymmetric so a wrong bucket gives a different total. Skips when no database.
 */
describe('integration-real-postgres: L6 Overview and Finance reconcile', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;
  let finance: UnifiedFinanceService;
  let world: World;

  const owner = { id: 'l6-itest-owner', roles: [] } as never;
  const suffix = `l6-${Date.now()}`;

  const READY_KEPT = 91_300;
  const READY_FEE = 2_700;
  const READY_REFUNDED = 23_900;
  const CANCELLED_KEPT = 41_700;
  const CANCELLED_REFUNDED = 12_200;
  const HELD = 18_600;
  // A fee on a show still to come: `held` is stated before it, the Overview after it.
  const HELD_FEE = 1_150;
  const CASH = 6_450;

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

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
    finance = new UnifiedFinanceService(
      db as never,
      { assertMember: async () => undefined, isPlatformAdmin: () => true } as never,
    );
    world = await makeWorld(db, suffix);

    // Org A, a1: finished and payable. One sale kept (with a platform fee), one refunded in full.
    await sell(db, world, world.orgA, world.a1, {
      subtotalMinor: READY_KEPT,
      organizerFeeMinor: READY_FEE,
    });
    const gone = await sell(db, world, world.orgA, world.a1, { subtotalMinor: READY_REFUNDED });
    await refund(db, world.orgA, gone.id, READY_REFUNDED);

    // Org A, a2: CANCELLED with one sale still not refunded - the QA "K-TEST Neon Nights Live".
    await db.event.update({ where: { id: world.a2 }, data: { status: 'CANCELLED' } });
    await sell(db, world, world.orgA, world.a2, { subtotalMinor: CANCELLED_KEPT });
    const back = await sell(db, world, world.orgA, world.a2, { subtotalMinor: CANCELLED_REFUNDED });
    await refund(db, world.orgA, back.id, CANCELLED_REFUNDED);

    // Org A, aLive: still to come, so held. Plus a cash sale at the counter.
    await sell(db, world, world.orgA, world.aLive, {
      subtotalMinor: HELD,
      organizerFeeMinor: HELD_FEE,
    });
    const cash = await sell(db, world, world.orgA, world.aLive, { subtotalMinor: CASH });
    await db.booking.update({ where: { id: cash.id }, data: { paymentMethod: 'CASH' } });

    // Org A has the QA settlement rows too: accrued with no account, moved nothing.
    for (const eventId of [world.a1, world.a2, world.aLive]) {
      await db.settlement.create({
        data: {
          organizationId: world.orgA,
          eventId,
          currency: 'inr',
          provider: 'razorpay',
          status: eventId === world.aLive ? 'HELD' : 'ELIGIBLE',
          grossSalesMinor: 77_777,
          accountId: null,
          connectedAccountId: null,
        },
      });
    }

    // Org B, b1: cancelled, but a provider transfer claimed it - provider money, not "cancelled".
    await db.event.update({ where: { id: world.b1 }, data: { status: 'CANCELLED' } });
    await sell(db, world, world.orgB, world.b1, { subtotalMinor: 33_300 });
    await claimWithProvider(db, world.orgB, world.b1);
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await cleanWorld(db, world);
    await db.$disconnect();
  }, 60_000);

  /** The Overview's definition (`AnalyticsService.revenueByCurrency` + completed refunds). */
  async function overviewAfterRefundsAndFee(orgId: string) {
    const sold = await db!.booking.aggregate({
      where: { organizationId: orgId, currency: 'INR', confirmedAt: { not: null } },
      _sum: { subtotalMinor: true, organizerFeeMinor: true },
    });
    const refunded = await db!.refund.aggregate({
      where: { organizationId: orgId, status: 'COMPLETED' },
      _sum: { amountMinor: true },
    });
    return (
      (sold._sum.subtotalMinor ?? 0) -
      (sold._sum.organizerFeeMinor ?? 0) -
      (refunded._sum.amountMinor ?? 0)
    );
  }

  it('reports cancelled-event sales and cash, after refunds', async () => {
    if (!guard()) return;
    const inr = (await payouts.summary(owner, world.orgA)).currencies.find(
      (c) => c.currency === 'INR',
    )!;
    expect(inr.cancelled).toBe(CANCELLED_KEPT);
    expect(inr.cash).toBe(CASH);
    expect(inr.held).toBe(HELD);
    expect(inr.net).toBe(READY_KEPT - READY_FEE);
    // The fee inside held: the ready fee is already off `net`, so it is not counted again.
    expect(inr.feeNotDeducted).toBe(HELD_FEE);
  });

  it('puts every rupee of the Overview in exactly one Finance figure', async () => {
    if (!guard()) return;
    const inr = (await payouts.summary(owner, world.orgA)).currencies.find(
      (c) => c.currency === 'INR',
    )!;
    const buckets =
      inr.held + inr.net + inr.pending + inr.paid + inr.cancelled + inr.cash - inr.feeNotDeducted;
    // 194 150 sold - 36 100 refunded - 2 700 - 1 150 fees = 154 200.
    expect(await overviewAfterRefundsAndFee(world.orgA)).toBe(154_200);
    expect(buckets).toBe(154_200);
  });

  it('still reconciles once a payout is raised', async () => {
    if (!guard()) return;
    // The settlements here have moved nothing, so the generator pays these events (FIN-1).
    const created = await payouts.generate(owner, world.orgA);
    expect(created).toHaveLength(1);
    const inr = (await payouts.summary(owner, world.orgA)).currencies.find(
      (c) => c.currency === 'INR',
    )!;
    expect(inr.pending).toBe(READY_KEPT - READY_FEE);
    expect(inr.net).toBe(0);
    expect(
      inr.held + inr.net + inr.pending + inr.paid + inr.cancelled + inr.cash - inr.feeNotDeducted,
    ).toBe(await overviewAfterRefundsAndFee(world.orgA));
  });

  it('shows no provider route and raises no double claim for unmoved settlements', async () => {
    if (!guard()) return;
    const inr = (await finance.forOrganization(owner, world.orgA)).currencies.find(
      (c) => c.currency === 'INR',
    )!;
    // All three are still listed: nothing is hidden.
    expect(inr.entries.filter((e) => e.path === 'PROVIDER')).toHaveLength(3);
    // But none of it is provider money, and a payout beside one is not two routes.
    expect(inr.providerRoute).toBeUndefined();
    expect(inr.warnings.map((w) => w.code)).not.toContain('DOUBLE_CLAIM');
  });

  it('scopes to one event', async () => {
    if (!guard()) return;
    const inr = (await payouts.summary(owner, world.orgA, world.a2)).currencies.find(
      (c) => c.currency === 'INR',
    )!;
    expect(inr.cancelled).toBe(CANCELLED_KEPT);
    expect(inr.cash).toBe(0);
    expect(inr.held).toBe(0);
  });

  it('leaves a provider-claimed cancelled event to the provider route', async () => {
    if (!guard()) return;
    const summary = await payouts.summary(owner, world.orgB);
    expect(summary.excluded.providerSettledEvents).toBe(1);
    expect(summary.currencies.find((c) => c.currency === 'INR')?.cancelled ?? 0).toBe(0);
    const inr = (await finance.forOrganization(owner, world.orgB)).currencies.find(
      (c) => c.currency === 'INR',
    )!;
    expect(inr.providerRoute?.entitlementMinor).toBe(100_000);
  });

  it('moves no money: reading changes no settlement, payout, refund or booking', async () => {
    if (!guard()) return;
    const orgs = [world.orgA, world.orgB];
    const snap = async () =>
      JSON.stringify([
        await db!.settlement.findMany({
          where: { organizationId: { in: orgs } },
          orderBy: { id: 'asc' },
        }),
        await db!.payout.findMany({
          where: { organizationId: { in: orgs } },
          orderBy: { id: 'asc' },
        }),
        await db!.refund.findMany({
          where: { organizationId: { in: orgs } },
          orderBy: { id: 'asc' },
        }),
        await db!.booking.findMany({
          where: { organizationId: { in: orgs } },
          orderBy: { id: 'asc' },
        }),
      ]);
    const before = await snap();
    for (const org of orgs) {
      await payouts.summary(owner, org);
      await finance.forOrganization(owner, org);
    }
    expect(await snap()).toBe(before);
  });
});
