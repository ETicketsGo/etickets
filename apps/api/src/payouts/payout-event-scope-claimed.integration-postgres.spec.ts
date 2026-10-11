import { PayoutsService } from './payouts.service';
import {
  Client,
  World,
  claimWithProvider,
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
 * integration-real-postgres - an event-scoped payout for an event the provider path has already
 * claimed settles NOTHING, and does not fall back to the organization's other events.
 *
 * ── THE BUG THIS REPRODUCES ────────────────────────────────────────────────────────
 * `settlementScope` reads provider settlements filtered to the requested event, so for an
 * event-scoped request `transferredEventIds` is either empty or exactly [eventId]. The payout,
 * refund and held-revenue queries then wrote
 *
 *     ...(eventId ? { eventId } : {}),
 *     ...(transferred.length > 0 ? { eventId: { notIn: transferred } } : {}),
 *
 * as two spread keys of one object. The second silently replaces the first, so the filter became
 * "every event of the organization EXCEPT the one asked for". A payout labelled with the claimed
 * event was built from, and allocated to, the organization's other events - and those events'
 * revenue was then paid again by their own payout.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
describe('integration-real-postgres: event-scoped payout of a provider-claimed event', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;
  let world: World;

  const owner = { id: 'scoping-claimed-itest-owner', roles: [] } as never;
  const suffix = `claimed-${Date.now()}`;
  let a2Booking = '';

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
    world = await makeWorld(db, suffix);

    await sell(db, world, world.orgA, world.a1, { subtotalMinor: 10_000 });
    const a2 = await sell(db, world, world.orgA, world.a2, { subtotalMinor: 7_000 });
    a2Booking = a2.id;
    await refund(db, world.orgA, a2.id, 1_000);
    await sell(db, world, world.orgA, world.aLive, { subtotalMinor: 4_321 });
    await sell(db, world, world.orgB, world.b1, { subtotalMinor: 3_000 });
    // The provider path has claimed event a1.
    await claimWithProvider(db, world.orgA, world.a1);
    await new Promise((r) => setTimeout(r, 15));
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await cleanWorld(db, world);
    await db.$disconnect();
  }, 60_000);

  it('reads nothing for the claimed event: no revenue, no refunds, no held money', async () => {
    if (!guard()) return;
    const summary = await payouts.summary(owner, world.orgA, world.a1);
    // Nothing to settle: a1 belongs to the provider path, and a2 / aLive are not in this scope.
    expect(summary.currencies.map((c) => c.net)).toEqual([]);
    expect(summary.heldRevenue).toEqual([]);
    expect(summary.excluded.providerSettledEvents).toBe(1);
  });

  it('refuses to raise a payout, and writes no payout or allocation for any event', async () => {
    if (!guard()) return;
    await expect(payouts.generate(owner, world.orgA, world.a1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await db!.payout.count({ where: { organizationId: world.orgA } })).toBe(0);
    expect(await db!.payoutAllocation.count({ where: { bookingId: a2Booking } })).toBe(0);
  });

  it('pays the other event once, by its own scope, and never twice', async () => {
    if (!guard()) return;
    const [own] = await payouts.generate(owner, world.orgA, world.a2);
    expect(own).toMatchObject({
      eventId: world.a2,
      netMinor:
        organizerShare({ subtotalMinor: 7_000, discountMinor: 0, organizerFeeMinor: 0 }) - 1_000,
    });
    await payouts.markPaid(owner, own.id, { reference: 'UTR-CLAIMED' });
    await new Promise((r) => setTimeout(r, 15));
    // Revenue for a2 has been paid; an event-scoped retry for the claimed a1 must still be empty.
    await expect(payouts.generate(owner, world.orgA, world.a1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const total = await db!.payoutAllocation.aggregate({
      where: { eventId: world.a2 },
      _sum: { allocatedNetMinor: true },
    });
    expect(total._sum.allocatedNetMinor).toBe(6_000);
  });
});
