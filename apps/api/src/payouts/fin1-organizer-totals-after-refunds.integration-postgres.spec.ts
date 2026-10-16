import { UnifiedFinanceService } from '../finance/unified-finance.service';
import { PayoutsService } from './payouts.service';
import {
  Client,
  World,
  cleanWorld,
  loadDatabaseUrl,
  makeWorld,
  newClient,
  payoutsServiceFor,
  refund,
  sell,
} from './payout-scoping.fixture';

/**
 * integration-real-postgres - FIN-1: what the organizer is shown after refunds.
 *
 * ── THE SYMPTOM (QA 2026-10-12) ────────────────────────────────────────────────────
 * Two of an event's bookings were refunded (refunds COMPLETED). `/payouts/summary` still said
 * held 299 600 and `/payouts/finance` still said pending 299 600, while the admin settlement row
 * (`refundsMinor 191 809`) and the generated payout (gross 299 600 - refund 199 800 = net 99 800)
 * were correct. Settlement and payout were right; two organizer READ models overstated it.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * Same shape as QA: an organization with NO linked payment account, a Razorpay settlement row the
 * payment webhook accrued anyway (`accountId` null), three paid bookings of which two are
 * refunded. Every figure is asserted against the organizer screens AND the rows an admin sees,
 * and the reconciliation identity is asserted: held + pending + paid + refunds = gross bookings.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
describe('integration-real-postgres: FIN-1 organizer totals after refunds', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;
  let finance: UnifiedFinanceService;
  let world: World;

  const owner = { id: 'fin1-itest-owner', roles: [] } as never;
  const suffix = `fin1-${Date.now()}`;

  // The QA amounts. B1 + B2 are refunded in full; B3 stays sold.
  const B1 = 149_900;
  const B2 = 49_900;
  const B3 = 99_800;
  const GROSS = B1 + B2 + B3; // 299 600
  const REFUNDED = B1 + B2; // 199 800
  const KEPT = GROSS - REFUNDED; // 99 800
  // The organizer's share of the refunds, as the webhook recorded it on QA.
  const SETTLEMENT_REFUNDS = 191_809;

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

  /** The state QA had: accrued by the payment webhook for an org with no linked account. */
  const settlementWithoutAccount = (orgId: string, eventId: string, status: string) =>
    db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId,
        currency: 'inr',
        provider: 'razorpay',
        status,
        grossSalesMinor: GROSS,
        refundsMinor: SETTLEMENT_REFUNDS,
        accountId: null,
        connectedAccountId: null,
      },
    });

  async function sellAndRefund(orgId: string, eventId: string) {
    const b1 = await sell(db!, world, orgId, eventId, { subtotalMinor: B1 });
    const b2 = await sell(db!, world, orgId, eventId, { subtotalMinor: B2 });
    await sell(db!, world, orgId, eventId, { subtotalMinor: B3 });
    await refund(db!, orgId, b1.id, B1);
    await refund(db!, orgId, b2.id, B2);
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
    finance = new UnifiedFinanceService(
      db as never,
      { assertMember: async () => undefined, isPlatformAdmin: () => true } as never,
    );
    world = await makeWorld(db, suffix);

    // Org A: the event has not finished, so its money is HELD and no payout exists yet.
    await sellAndRefund(world.orgA, world.aLive);
    await settlementWithoutAccount(world.orgA, world.aLive, 'HELD');
    // Org B: the event has finished, so a platform payout is raised for the same kind of revenue
    // while the provider settlement row (it can never release - no account) still stands.
    await sellAndRefund(world.orgB, world.b1);
    await settlementWithoutAccount(world.orgB, world.b1, 'ELIGIBLE');
    await new Promise((r) => setTimeout(r, 15));
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await cleanWorld(db, world);
    await db.$disconnect();
  }, 60_000);

  describe('held revenue (event not finished)', () => {
    it('holds only what is left after refunds, per currency and per event', async () => {
      if (!guard()) return;
      const summary = await payouts.summary(owner, world.orgA);
      const inr = summary.currencies.find((c) => c.currency === 'INR')!;
      // Was 299 600: every booking's subtotal, refunded or not.
      expect(inr.held).toBe(KEPT);
      expect(summary.heldRevenue).toHaveLength(1);
      expect(summary.heldRevenue[0].grossMinor).toBe(KEPT);
      expect(summary.heldRevenue[0].refundedMinor).toBe(REFUNDED);
    });

    it('reconciles: held + refunds = gross bookings', async () => {
      if (!guard()) return;
      const summary = await payouts.summary(owner, world.orgA);
      const inr = summary.currencies.find((c) => c.currency === 'INR')!;
      const sold = await db!.booking.aggregate({
        where: { organizationId: world.orgA, eventId: world.aLive },
        _sum: { subtotalMinor: true },
      });
      const refunded = await db!.refund.aggregate({
        where: { organizationId: world.orgA, status: 'COMPLETED' },
        _sum: { amountMinor: true },
      });
      expect(sold._sum.subtotalMinor).toBe(GROSS);
      expect(inr.held + inr.pending + inr.paid + (refunded._sum.amountMinor ?? 0)).toBe(GROSS);
    });

    it('does not show a fully refunded event as held money', async () => {
      if (!guard()) return;
      const only = await db!.organization.create({
        data: { name: `Fin1 refunded ${suffix}`, slug: `fin1-refunded-${suffix}` },
      });
      try {
        const venue = await db!.venue.create({
          data: { organizationId: only.id, name: `V ${suffix}`, city: 'Pune', country: 'India' },
        });
        const ev = await db!.event.create({
          data: {
            organizationId: only.id,
            venueId: venue.id,
            title: `Fin1 gone ${suffix}`,
            slug: `fin1-gone-${suffix}`,
            category: 'Music',
            status: 'PUBLISHED',
          },
        });
        const session = await db!.eventSession.create({
          data: {
            eventId: ev.id,
            startsAt: new Date(Date.now() + 86_400_000),
            endsAt: new Date(Date.now() + 90_000_000),
            status: 'SCHEDULED',
          },
        });
        const w = { ...world, sessions: { [ev.id]: session.id } };
        const b = await sell(db!, w, only.id, ev.id, { subtotalMinor: 5_000 });
        await refund(db!, only.id, b.id, 5_000);
        const summary = await payouts.summary(owner, only.id);
        expect(summary.heldRevenue).toEqual([]);
        expect(summary.currencies.find((c) => c.currency === 'INR')?.held ?? 0).toBe(0);
      } finally {
        await db!.refund.deleteMany({ where: { organizationId: only.id } });
        await db!.booking.deleteMany({ where: { organizationId: only.id } });
        await db!.eventSession.deleteMany({ where: { event: { organizationId: only.id } } });
        await db!.event.deleteMany({ where: { organizationId: only.id } });
        await db!.venue.deleteMany({ where: { organizationId: only.id } });
        await db!.organization.delete({ where: { id: only.id } });
      }
    });
  });

  describe('/payouts/finance (provider settlement, no linked account, no payout yet)', () => {
    it('counts what is owed AFTER the refunds the settlement already recorded', async () => {
      if (!guard()) return;
      const composed = await finance.forOrganization(owner, world.orgA);
      const inr = composed.currencies.find((c) => c.currency === 'INR')!;
      // Was 299 600: grossSalesMinor, with the 191 809 of refunds sitting beside it unused.
      expect(inr.summary.pendingMinor).toBe(GROSS - SETTLEMENT_REFUNDS);
      expect(inr.summary.entitlementMinor).toBe(GROSS - SETTLEMENT_REFUNDS);
      // The admin row says the same thing the organizer is shown.
      const row = await db!.settlement.findFirst({ where: { organizationId: world.orgA } });
      expect(inr.summary.pendingMinor).toBe(row!.grossSalesMinor - row!.refundsMinor);
    });

    it('is not provider money: the held figure on /payouts/summary already counts it (L6)', async () => {
      if (!guard()) return;
      const composed = await finance.forOrganization(owner, world.orgA);
      const inr = composed.currencies.find((c) => c.currency === 'INR')!;
      const summary = await payouts.summary(owner, world.orgA);
      // The ledger holds this event's money...
      expect(summary.currencies.find((c) => c.currency === 'INR')!.held).toBe(KEPT);
      // ...so "Settled by your payment provider" must not show it a second time.
      expect(inr.paths.map((p) => p.path)).toContain('PROVIDER');
      expect(inr.providerRoute).toBeUndefined();
    });
  });

  describe('platform payout raised for the same revenue as an unmoved settlement', () => {
    it('generates the payout the admin sees: gross - refund = net', async () => {
      if (!guard()) return;
      const created = await payouts.generate(owner, world.orgB);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        grossMinor: GROSS,
        refundMinor: REFUNDED,
        netMinor: KEPT,
      });
    });

    it('does not count the same revenue on both ledgers', async () => {
      if (!guard()) return;
      const composed = await finance.forOrganization(owner, world.orgB);
      const inr = composed.currencies.find((c) => c.currency === 'INR')!;
      const payoutRow = await db!.payout.findFirst({ where: { organizationId: world.orgB } });
      // Was payout net + settlement gross: the one event's money twice.
      expect(inr.summary.pendingMinor).toBe(payoutRow!.netMinor);
      expect(inr.summary.entitlementMinor).toBe(payoutRow!.netMinor);
      // Nothing is hidden: the settlement is still listed.
      expect(inr.entries).toHaveLength(2);
      /*
        L6 (QA 2026-10-16): and it is NOT a double claim. The settlement has moved nothing, so it
        has claimed nothing; the payout is the designed route for an org with no linked account.
        Reporting it showed every such organizer "Needs attention: An event appears in two payment
        routes at once" with nothing wrong. Nor is it provider money: no `providerRoute`.
      */
      expect(inr.warnings.map((w) => w.code)).not.toContain('DOUBLE_CLAIM');
      expect(inr.providerRoute).toBeUndefined();
    });

    it('reconciles: pending + paid + refunds = gross bookings, and matches /payouts/summary', async () => {
      if (!guard()) return;
      const composed = await finance.forOrganization(owner, world.orgB);
      const inr = composed.currencies.find((c) => c.currency === 'INR')!;
      const summary = await payouts.summary(owner, world.orgB);
      const s = summary.currencies.find((c) => c.currency === 'INR')!;
      const payoutRow = await db!.payout.findFirst({ where: { organizationId: world.orgB } });
      expect(inr.summary.pendingMinor + inr.summary.paidMinor + payoutRow!.refundMinor).toBe(GROSS);
      // Both organizer screens give the same owed figure.
      expect(s.pending).toBe(inr.summary.pendingMinor);
      expect(s.held).toBe(0);
    });

    it('moves no money: reading changes no settlement, payout or booking', async () => {
      if (!guard()) return;
      const snap = async () =>
        JSON.stringify([
          await db!.settlement.findMany({
            where: { organizationId: world.orgB },
            orderBy: { id: 'asc' },
          }),
          await db!.payout.findMany({
            where: { organizationId: world.orgB },
            orderBy: { id: 'asc' },
          }),
          await db!.refund.findMany({
            where: { organizationId: world.orgB },
            orderBy: { id: 'asc' },
          }),
        ]);
      const before = await snap();
      await finance.forOrganization(owner, world.orgB);
      await payouts.summary(owner, world.orgB);
      expect(await snap()).toBe(before);
    });
  });
});
