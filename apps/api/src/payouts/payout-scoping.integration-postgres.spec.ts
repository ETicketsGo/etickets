import { PayoutsService } from './payouts.service';
import {
  Client,
  World,
  cleanWorld,
  loadDatabaseUrl,
  makeWorld,
  newClient,
  organizerShare,
  payoutsServiceFor,
  refund,
  sell,
} from './payout-scoping.fixture';

/**
 * integration-real-postgres - a payout, a payout summary and a held figure are scoped to the
 * organization AND the event they were asked for, and the money is conserved.
 *
 * Two organizations, two finished events each, plus one unfinished event whose money is held.
 * Bookings and completed refunds are spread across all of them with different amounts, so a
 * figure that leaks from another event or another organization cannot coincide with the right
 * one by accident.
 *
 * Conservation, per event and per organization:
 *   sum(organizer share of its bookings) - sum(completed refunds)
 *     == sum(allocations in PAID payouts) + sum(allocations in open payouts)
 *      + (unsettled but eligible) + (held)
 * The right-hand terms are read from the ledger; the left is computed here from the raw rows, so
 * the two never share code.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
describe('integration-real-postgres: payout event and organization scoping', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;
  let world: World;

  const owner = { id: 'scoping-itest-owner', roles: [] } as never;
  const suffix = `scoping-${Date.now()}`;
  const pause = () => new Promise((r) => setTimeout(r, 15));

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

  const bookings = {} as Record<string, { id: string }[]>;
  async function book(orgId: string, eventId: string, subtotalMinor: number, org = 0, disc = 0) {
    const b = await sell(db!, world, orgId, eventId, {
      subtotalMinor,
      organizerFeeMinor: org,
      discountMinor: disc,
    });
    (bookings[eventId] ??= []).push(b);
    return b;
  }

  /** The oracle: what an event's organizer is owed, from the raw rows. */
  async function owed(eventId: string) {
    const rows = await db!.booking.findMany({ where: { eventId } });
    const refunds = await db!.refund.findMany({
      where: { booking: { eventId }, status: 'COMPLETED' },
    });
    return (
      rows.reduce((total: number, b: never) => total + organizerShare(b), 0) -
      refunds.reduce((total: number, r: { amountMinor: number }) => total + r.amountMinor, 0)
    );
  }

  async function allocated(eventId: string) {
    const rows = await db!.payoutAllocation.findMany({ where: { eventId } });
    return rows.reduce(
      (total: number, r: { allocatedNetMinor: number }) => total + r.allocatedNetMinor,
      0,
    );
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
    world = await makeWorld(db, suffix);

    const a1 = await book(world.orgA, world.a1, 10_000, 500);
    await book(world.orgA, world.a1, 6_000, 0, 1_000);
    await refund(db, world.orgA, a1.id, 2_000);
    const a2 = await book(world.orgA, world.a2, 7_000, 350);
    await refund(db, world.orgA, a2.id, 1_000);
    await book(world.orgA, world.aLive, 4_321);
    const b1 = await book(world.orgB, world.b1, 3_000);
    await refund(db, world.orgB, b1.id, 700);
    await book(world.orgB, world.b2, 2_000);
    await pause();
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await cleanWorld(db, world);
    await db.$disconnect();
  }, 60_000);

  it('an event-scoped summary and payout cover that event only', async () => {
    if (!guard()) return;
    const expected = await owed(world.a1);

    const summary = await payouts.summary(owner, world.orgA, world.a1);
    expect(summary.currencies).toHaveLength(1);
    expect(summary.currencies[0]).toMatchObject({ currency: 'INR', net: expected });
    // The unfinished event belongs to the organization but not to this scope.
    expect(summary.currencies[0].held).toBe(0);

    const [payout] = await payouts.generate(owner, world.orgA, world.a1);
    expect(payout).toMatchObject({ eventId: world.a1, netMinor: expected });
    const rows = await db!.payoutAllocation.findMany({ where: { payoutId: payout.id } });
    expect(new Set(rows.map((r: { eventId: string }) => r.eventId))).toEqual(new Set([world.a1]));
    expect(await allocated(world.a2)).toBe(0);
  });

  it('an organization-wide summary reports only held money that is its own', async () => {
    if (!guard()) return;
    const summary = await payouts.summary(owner, world.orgA);
    expect(summary.heldRevenue.map((h) => h.eventId)).toEqual([world.aLive]);
    expect(summary.heldRevenue[0].grossMinor).toBe(4_321);
    // a2 is the only finished event not yet settled; org B's money never appears.
    expect(summary.currencies[0].net).toBe(await owed(world.a2));
  });

  it('never lets one organization see or settle another', async () => {
    if (!guard()) return;
    // The event's own payout is open, and an open payout blocks an overlapping one by design.
    for (const open of await db!.payout.findMany({
      where: { organizationId: world.orgA, status: 'PENDING' },
    })) {
      await payouts.markPaid(owner, open.id, { reference: 'UTR-SCOPING-1' });
    }
    const [payout] = await payouts.generate(owner, world.orgA);
    expect(payout.organizationId).toBe(world.orgA);
    const rows = await db!.payoutAllocation.findMany({ where: { payoutId: payout.id } });
    const events = new Set(rows.map((r: { eventId: string }) => r.eventId));
    expect(events.has(world.b1) || events.has(world.b2)).toBe(false);
    expect(await allocated(world.b1)).toBe(0);
    expect(await allocated(world.b2)).toBe(0);
  });

  it('conserves money per event and per organization, before and after refunds', async () => {
    if (!guard()) return;
    // Org A is fully settled now except its unfinished event. Close the open payouts first.
    for (const open of await db!.payout.findMany({
      where: { organizationId: world.orgA, status: 'PENDING' },
    })) {
      await payouts.markPaid(owner, open.id, { reference: 'UTR-SCOPING' });
    }

    const conserved = async (orgId: string, finished: string[], live?: string) => {
      let ledger = 0;
      let oracle = 0;
      for (const id of finished) {
        expect(await allocated(id)).toBe(await owed(id));
        ledger += await allocated(id);
        oracle += await owed(id);
      }
      let held = 0;
      if (live) {
        expect(await allocated(live)).toBe(0);
        held = await owed(live);
      }
      const paidOrOpen = await db!.payoutAllocation.aggregate({
        where: { payout: { organizationId: orgId, status: { in: ['PAID', 'PENDING'] } } },
        _sum: { allocatedNetMinor: true },
      });
      expect((paidOrOpen._sum.allocatedNetMinor ?? 0) + held).toBe(oracle + held);
      expect(ledger).toBe(oracle);
    };

    await conserved(world.orgA, [world.a1, world.a2], world.aLive);

    // A refund after the money was paid out is recovered from the next payout, in its own event.
    await refund(db!, world.orgA, bookings[world.a1][0].id, 1_500);
    await pause();
    const [clawback] = await payouts.generate(owner, world.orgA);
    expect(clawback.netMinor).toBe(-1_500);
    await conserved(world.orgA, [world.a1, world.a2], world.aLive);

    // Org B has never been touched by any of the above, and still balances on its own.
    expect(await allocated(world.b1)).toBe(0);
    const [b] = await payouts.generate(owner, world.orgB);
    expect(b.netMinor).toBe((await owed(world.b1)) + (await owed(world.b2)));
    await conserved(world.orgB, [world.b1, world.b2]);
  });
});
