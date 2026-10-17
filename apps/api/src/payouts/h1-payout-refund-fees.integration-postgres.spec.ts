import { AnalyticsService } from '../analytics/analytics.service';
import { RazorpayWebhookProcessor } from '../payments/razorpay/razorpay-webhook.processor';
import { SettlementService } from '../payments/settlement/settlement.service';
import { organizerShareOfRefund } from './currency-settlement.calculator';
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
 * integration-real-postgres - H1: a payout charges the organizer only THEIR share of a refund.
 *
 * ── THE DEFECT (found in #417) ─────────────────────────────────────────────────────
 * A cancelled show returns the buyer everything they paid, the booking and payment fees too, and
 * the refund row records those fees as `platformFeeRefundedMinor`. The read models (#401/#417)
 * take only `organizerShareOfRefund` off the organizer: the refund less the tax added on top and
 * less those fees, which were never in the organizer's gross. `PayoutsService.settle` - the payout
 * WRITER - built its refund rows without that column, so a real payout deducted the whole refund,
 * fees included. A cancelled event is never payable, so this hid until one DATE of an event is
 * cancelled and refunded and the event then completes: the payout took the buyer's fees out of the
 * organizer's money.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * Through the real `generate` (payout rows and allocations are written), the real Finance read
 * (`summary`) and the real Overview read (`AnalyticsService.organizer`), for: one cancelled date of
 * an event that completes; a whole cancelled event; two payout periods with the refund landing in
 * the second; a refund that crosses periods on BOTH the ledger and the provider-settlement path;
 * and partial refunds with and without fees. Every expected figure is written out by hand, in
 * paisa, so a wrong deduction cannot hide behind a wrong total. Each case also checks
 *
 *     payouts + organizer fee + organizer's share of refunds + held + cancelled = gross
 *
 * and that the #417 bridge (Overview net = what came off gross = where the money is) still holds.
 *
 * Every case has its own two-organization world so one cannot feed another. Skips when no DB.
 */
describe('integration-real-postgres: H1 a payout deducts only the organizer share of a refund', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;
  let analytics: AnalyticsService;
  const worlds: World[] = [];
  const webhookIds: string[] = [];

  const owner = { id: 'h1-itest-owner', roles: [] } as never;
  const stamp = Date.now();
  let seq = 0;

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

  /** Two rows written a few ms apart must not share a timestamp: windows compare `>`. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

  async function newWorld() {
    seq += 1;
    const world = await makeWorld(db!, `h1-${stamp}-${seq}`);
    worlds.push(world);
    return world;
  }

  /** A second date of an event, called off. In the past, so the event can still complete. */
  async function cancelledDate(eventId: string) {
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() - 80_000_000),
        endsAt: new Date(Date.now() - 76_000_000),
        status: 'CANCELLED',
      },
    });
    return session.id;
  }

  /** A sale whose buyer paid booking and payment fees on top of the ticket. */
  async function sellWithFees(
    world: World,
    eventId: string,
    amounts: { subtotalMinor: number; buyerFeesMinor: number; organizerFeeMinor?: number },
    sessionId?: string,
  ) {
    const b = await sell(db!, world, world.orgA, eventId, {
      subtotalMinor: amounts.subtotalMinor,
      organizerFeeMinor: amounts.organizerFeeMinor ?? 0,
    });
    return db!.booking.update({
      where: { id: b.id },
      data: {
        bookingFeeMinor: amounts.buyerFeesMinor,
        totalMinor: amounts.subtotalMinor + amounts.buyerFeesMinor,
        ...(sessionId ? { eventSessionId: sessionId } : {}),
      },
    });
  }

  /**
   * A refund as `RefundsService` writes it. A cancellation returns `booking.totalMinor` less what
   * was already refunded, and records the fee part of that as `platformFeeRefundedMinor`; a
   * buyer-requested refund returns the tickets only and records 0.
   */
  async function refund(
    world: World,
    bookingId: string,
    amountMinor: number,
    platformFeeRefundedMinor: number,
    opts: {
      bookingStatus?: 'REFUNDED' | 'PARTIALLY_REFUNDED';
      status?: 'COMPLETED' | 'PROCESSING';
      providerRef?: string;
    } = {},
  ) {
    const row = await db!.refund.create({
      data: {
        bookingId,
        organizationId: world.orgA,
        amountMinor,
        platformFeeRefundedMinor,
        status: opts.status ?? 'COMPLETED',
        reason: 'h1-itest',
        ...(opts.providerRef ? { providerRef: opts.providerRef } : {}),
      },
    });
    if (opts.bookingStatus) {
      await db!.booking.update({ where: { id: bookingId }, data: { status: opts.bookingStatus } });
    }
    return row;
  }

  interface AllocationRow {
    bookingId: string;
    allocatedNetMinor: number;
    refundShareMinor: number;
  }
  interface PayoutRow {
    id: string;
    grossMinor: number;
    refundMinor: number;
    netMinor: number;
    allocations: AllocationRow[];
  }

  async function payoutRows(world: World): Promise<PayoutRow[]> {
    return db!.payout.findMany({
      where: { organizationId: world.orgA },
      orderBy: { createdAt: 'asc' },
      include: { allocations: true },
    });
  }

  /** The allocations must explain the payout exactly (PayoutAllocation, #184-#190). */
  function expectAllocationsExplain(payout: {
    netMinor: number;
    refundMinor: number;
    allocations: { allocatedNetMinor: number; refundShareMinor: number }[];
  }) {
    const net = payout.allocations.reduce((s, a) => s + a.allocatedNetMinor, 0);
    const share = payout.allocations.reduce((s, a) => s + a.refundShareMinor, 0);
    expect(net).toBe(payout.netMinor);
    expect(share).toBe(payout.refundMinor);
  }

  type Loose = Record<string, number | string | undefined>;
  const n = (row: Loose | undefined, key: string) => Number(row?.[key] ?? 0);

  /**
   * #417's bridge. Left: the Overview's gross less what came off it. Right: where that money is.
   * Both must equal the Overview net, which must equal `expectedNet`.
   */
  async function expectBridge(world: World, expectedNet: number) {
    const overview = (await analytics.organizer(owner, world.orgA)).revenue?.find(
      (r) => r.currency === 'INR',
    ) as unknown as Loose;
    const ledger = (await payouts.summary(owner, world.orgA)).currencies.find(
      (c) => c.currency === 'INR',
    ) as unknown as Loose;
    const left =
      n(overview, 'grossMinor') -
      n(overview, 'refundedSalesMinor') -
      n(overview, 'cashGivenBackMinor') -
      n(overview, 'organizerFeesMinor');
    const right =
      n(ledger, 'held') +
      n(ledger, 'net') +
      n(ledger, 'pending') +
      n(ledger, 'paid') +
      n(ledger, 'cancelled') +
      n(ledger, 'cash') +
      n(ledger, 'cashToReturn') -
      n(ledger, 'feeNotDeducted');
    expect(n(overview, 'netMinor')).toBe(expectedNet);
    expect(left).toBe(expectedNet);
    expect(right).toBe(expectedNet);
    return { overview, ledger };
  }

  /** The organizer's share of every completed refund in the world, by the calculator's rule. */
  async function refundShareOf(world: World) {
    const rows: { amountMinor: number; taxAddedMinor: number; platformFeeRefundedMinor: number }[] =
      await db!.refund.findMany({
        where: { organizationId: world.orgA, status: 'COMPLETED' },
        select: { amountMinor: true, taxAddedMinor: true, platformFeeRefundedMinor: true },
      });
    return rows.reduce((s, r) => s + organizerShareOfRefund({ ...r, currency: 'INR' }), 0);
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
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    if (webhookIds.length > 0) {
      await db.webhookEvent.deleteMany({ where: { id: { in: webhookIds } } });
    }
    for (const world of worlds) await cleanWorld(db, world);
    await db.$disconnect();
  }, 60_000);

  // (a) One date of a two-date event is called off and refunded with its fees; the event completes.
  it('(a) partial cancellation: the payout takes off the ticket money, not the buyer fees', async () => {
    if (!guard()) return;
    const w = await newWorld();
    const off = await cancelledDate(w.a1);
    // The date that went ahead.
    await sellWithFees(w, w.a1, {
      subtotalMinor: 50_000,
      buyerFeesMinor: 2_000,
      organizerFeeMinor: 1_500,
    });
    // The date that was called off: Rs 312.60 returned, Rs 12.60 of it booking and payment fees.
    const lost = await sellWithFees(
      w,
      w.a1,
      { subtotalMinor: 30_000, buyerFeesMinor: 1_260, organizerFeeMinor: 900 },
      off,
    );
    await refund(w, lost.id, 31_260, 1_260, { bookingStatus: 'REFUNDED' });

    await payouts.generate(owner, w.orgA);
    const [payout, ...rest] = await payoutRows(w);
    expect(rest).toHaveLength(0);
    // 80 000 sold - 2 400 organizer fee - 30 000 ticket money returned. The bug took 31 260.
    expect(payout.grossMinor).toBe(80_000);
    expect(payout.refundMinor).toBe(30_000);
    expect(payout.netMinor).toBe(47_600);
    expectAllocationsExplain(payout);
    const lostAllocation = payout.allocations.find((a) => a.bookingId === lost.id)!;
    expect(lostAllocation.refundShareMinor).toBe(30_000);
    expect(lostAllocation.allocatedNetMinor).toBe(-900);

    // payout + organizer fee + organizer share of refunds + held = gross.
    const { ledger } = await expectBridge(w, 47_600);
    expect(await refundShareOf(w)).toBe(30_000);
    expect(payout.netMinor + 2_400 + 30_000 + n(ledger, 'held')).toBe(80_000);
    expect(n(ledger, 'pending')).toBe(47_600);
    expect(n(ledger, 'net')).toBe(0);
  });

  // (b) The whole event is called off: its money is owed back, so it is never paid out.
  it('(b) full cancellation: no payout, and the money stays owed back to buyers', async () => {
    if (!guard()) return;
    const w = await newWorld();
    await db!.event.update({ where: { id: w.a2 }, data: { status: 'CANCELLED' } });
    const refunded = await sellWithFees(w, w.a2, { subtotalMinor: 40_000, buyerFeesMinor: 1_680 });
    await refund(w, refunded.id, 41_680, 1_680, { bookingStatus: 'REFUNDED' });
    // A second buyer whose refund has not been paid yet.
    await sellWithFees(w, w.a2, { subtotalMinor: 20_000, buyerFeesMinor: 840 });

    // Refused or empty, whichever the writer does with nothing to settle: no row either way.
    await payouts.generate(owner, w.orgA).catch(() => []);
    expect(await payoutRows(w)).toHaveLength(0);

    // 60 000 sold - 40 000 ticket money returned. The other 20 000 is owed back, not paid.
    const { ledger } = await expectBridge(w, 20_000);
    expect(n(ledger, 'cancelled')).toBe(20_000);
    expect(n(ledger, 'net')).toBe(0);
    expect(n(ledger, 'pending') + n(ledger, 'paid')).toBe(0);
    expect(0 + 0 + (await refundShareOf(w)) + n(ledger, 'held') + n(ledger, 'cancelled')).toBe(
      60_000,
    );
  });

  // (c) Paid out in period 1, refunded in period 2: the deduction lands once, in period 2.
  it('(c) multiple payouts: a later refund comes off the next payout, at the organizer share, once', async () => {
    if (!guard()) return;
    const w = await newWorld();
    const off = await cancelledDate(w.a1);
    await sellWithFees(w, w.a1, {
      subtotalMinor: 50_000,
      buyerFeesMinor: 2_000,
      organizerFeeMinor: 1_500,
    });
    const lost = await sellWithFees(
      w,
      w.a1,
      { subtotalMinor: 30_000, buyerFeesMinor: 1_260, organizerFeeMinor: 900 },
      off,
    );
    // The cancellation refund is still with the provider when the first payout is raised.
    const pending = await refund(w, lost.id, 31_260, 1_260, { status: 'PROCESSING' });

    await payouts.generate(owner, w.orgA);
    const [first] = await payoutRows(w);
    // Period 1 pays both sales: 80 000 - 2 400.
    expect(first.netMinor).toBe(77_600);
    expect(first.refundMinor).toBe(0);
    await payouts.markPaid(owner, first.id);

    // Period 2: the refund completes, and a new sale on another finished event.
    await tick();
    await db!.refund.update({ where: { id: pending.id }, data: { status: 'COMPLETED' } });
    await db!.booking.update({ where: { id: lost.id }, data: { status: 'REFUNDED' } });
    await sellWithFees(w, w.a2, {
      subtotalMinor: 20_000,
      buyerFeesMinor: 800,
      organizerFeeMinor: 600,
    });
    await tick();

    await payouts.generate(owner, w.orgA);
    const [, second, ...rest] = await payoutRows(w);
    expect(rest).toHaveLength(0);
    // 20 000 - 600 - 30 000. The bug deducted 31 260 here (net -11 860).
    expect(second.grossMinor).toBe(20_000);
    expect(second.refundMinor).toBe(30_000);
    expect(second.netMinor).toBe(-10_600);
    expectAllocationsExplain(second);
    const clawback = second.allocations.find((a) => a.bookingId === lost.id)!;
    expect(clawback.refundShareMinor).toBe(30_000);
    expect(clawback.allocatedNetMinor).toBe(-30_000);

    // Nothing left: a third generate must not deduct the same refund again.
    await tick();
    await payouts.generate(owner, w.orgA).catch(() => []);
    expect(await payoutRows(w)).toHaveLength(2);

    // 77 600 - 10 600 paid and pending + 3 000 fee + 30 000 share + 0 held = 100 000 sold.
    const { ledger } = await expectBridge(w, 67_000);
    expect(n(ledger, 'net')).toBe(0);
    expect(first.netMinor + second.netMinor + 3_000 + (await refundShareOf(w))).toBe(100_000);
    expect(n(ledger, 'held')).toBe(0);
  });

  // (d) The same sale and refund through BOTH paths: the ledger payout and the provider settlement.
  it('(d) a refund crossing periods: the ledger and the provider settlement take off the same share', async () => {
    if (!guard()) return;
    const w = await newWorld();
    const subtotalMinor = 30_000;
    const buyerFeesMinor = 1_260;
    const totalMinor = subtotalMinor + buyerFeesMinor;

    // ── Ledger path, event a1: paid out in period 1, refunded in period 2.
    const ledgerSale = await sellWithFees(w, w.a1, { subtotalMinor, buyerFeesMinor });
    await payouts.generate(owner, w.orgA);
    const [p1] = await payoutRows(w);
    expect(p1.netMinor).toBe(30_000);
    await payouts.markPaid(owner, p1.id);
    await tick();
    const ledgerRefund = await refund(w, ledgerSale.id, totalMinor, buyerFeesMinor, {
      bookingStatus: 'REFUNDED',
    });
    await tick();
    await payouts.generate(owner, w.orgA);
    const [, p2] = await payoutRows(w);
    expect(p2.refundMinor).toBe(30_000);
    expect(p2.netMinor).toBe(-30_000);
    expectAllocationsExplain(p2);

    // ── Provider path, event a2: the provider settlement is released in period 1 ...
    const providerSale = await sellWithFees(w, w.a2, { subtotalMinor, buyerFeesMinor });
    const providerPaymentId = `pay_h1_${stamp}_${seq}`;
    await db!.payment.create({
      data: {
        bookingId: providerSale.id,
        provider: 'razorpay',
        status: 'SUCCEEDED',
        amountMinor: totalMinor,
        currency: 'INR',
        subtotalMinor,
        platformFeeMinor: buyerFeesMinor,
        organizerNetMinor: subtotalMinor,
        providerPaymentIntentId: providerPaymentId,
      },
    });
    const reversals: number[] = [];
    const provider = {
      name: 'razorpay',
      capabilities: { supportsIdempotentTransfer: false, supportsTransferStatusQuery: false },
      createTransfer: async () => ({ kind: 'ACCEPTED', transferId: `trf_h1_${seq}`, raw: {} }),
      reverseTransfer: async (req: { amountMinor: number }) => {
        reversals.push(req.amountMinor);
        return {
          kind: 'CONFIRMED',
          confirmedMinor: req.amountMinor,
          reversalId: `rvsl_h1_${seq}`,
          raw: {},
        };
      },
    };
    const settlements = new SettlementService(
      db as never,
      { record: async () => undefined } as never,
      {
        send: async () => undefined,
        sendCritical: async () => undefined,
        fanOutCritical: async () => 0,
      } as never,
      {
        get: (key: string) =>
          key === 'PAYOUT_EXECUTION_ENABLED' || key === 'RAZORPAY_ROUTE_ENABLED' ? true : 0,
      } as never,
      { get: () => provider } as never,
    );
    const synced = await settlements.syncForEvent(w.a2);
    // Approval is an admin step this spec is not about.
    await db!.settlement.update({
      where: { id: synced!.id },
      data: { status: 'APPROVED', connectedAccountId: `acc_h1_${seq}` },
    });
    await settlements.release({ id: 'h1-ops' } as never, synced!.id, 'period 1');
    const released = await db!.settlement.findUniqueOrThrow({ where: { id: synced!.id } });
    expect(released.status).toBe('TRANSFERRED');
    expect(released.releasedMinor).toBe(30_000);

    // ... and the same cancellation refund completes in period 2, through the real webhook path.
    const providerRefundId = `rfnd_h1_${stamp}_${seq}`;
    const providerRefund = await refund(w, providerSale.id, totalMinor, buyerFeesMinor, {
      status: 'PROCESSING',
      providerRef: providerRefundId,
      bookingStatus: 'REFUNDED',
    });
    const event = await db!.webhookEvent.create({
      data: {
        provider: 'razorpay',
        providerEventId: `evt_h1_${stamp}_${seq}`,
        eventType: 'refund.processed',
        payload: {
          object: {
            refund: {
              entity: {
                id: providerRefundId,
                payment_id: providerPaymentId,
                amount: totalMinor,
                currency: 'inr',
              },
            },
          },
        },
      },
    });
    webhookIds.push(event.id);
    const processor = new RazorpayWebhookProcessor(
      db as never,
      {} as never,
      settlements,
      {} as never,
      { record: async () => undefined } as never,
    );
    await processor.process(event.id);
    expect(
      (await db!.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).processingStatus,
    ).toBe('PROCESSED');
    expect((await db!.refund.findUniqueOrThrow({ where: { id: providerRefund.id } })).status).toBe(
      'COMPLETED',
    );
    const after = await db!.settlement.findUniqueOrThrow({ where: { id: synced!.id } });

    // The two paths agree on the organizer's share, and it is the calculator's.
    const share = organizerShareOfRefund({ ...ledgerRefund, currency: 'INR' });
    expect(share).toBe(30_000);
    expect(after.refundsMinor).toBe(share);
    expect(reversals).toEqual([share]);
    expect(after.transferredMinor).toBe(0);
    expect(p2.refundMinor).toBe(share);
    // Over both periods each path leaves the organizer exactly 0 of this sale.
    expect(p1.netMinor + p2.netMinor).toBe(0);
    expect(after.releasedMinor - after.refundsMinor).toBe(0);
  });

  // (e) Partial refunds: some tickets back, with and without fees, on one completed event.
  it('(e) partial refunds: only the ticket money comes off, whatever fees went back with it', async () => {
    if (!guard()) return;
    const w = await newWorld();
    const off = await cancelledDate(w.a1);
    // Three Rs 100 tickets on the date that was called off, Rs 12 of fees.
    const three = await sellWithFees(
      w,
      w.a1,
      { subtotalMinor: 30_000, buyerFeesMinor: 1_200, organizerFeeMinor: 600 },
      off,
    );
    // The buyer first asked for one ticket back: tickets only, no fees ...
    await refund(w, three.id, 10_000, 0, { bookingStatus: 'PARTIALLY_REFUNDED' });
    // ... then the date was called off: the rest of what they paid, every fee included.
    await refund(w, three.id, 21_200, 1_200, { bookingStatus: 'REFUNDED' });
    // Two tickets on the date that went ahead; one handed back at the buyer's request.
    const two = await sellWithFees(w, w.a1, {
      subtotalMinor: 20_000,
      buyerFeesMinor: 700,
      organizerFeeMinor: 400,
    });
    await refund(w, two.id, 10_000, 0, { bookingStatus: 'PARTIALLY_REFUNDED' });

    await payouts.generate(owner, w.orgA);
    const [payout] = await payoutRows(w);
    // 50 000 - 1 000 organizer fee - (10 000 + 20 000 + 10 000). The bug took 41 200.
    expect(payout.grossMinor).toBe(50_000);
    expect(payout.refundMinor).toBe(40_000);
    expect(payout.netMinor).toBe(9_000);
    expectAllocationsExplain(payout);
    expect(payout.allocations.find((a) => a.bookingId === three.id)!.refundShareMinor).toBe(30_000);
    expect(payout.allocations.find((a) => a.bookingId === two.id)!.refundShareMinor).toBe(10_000);

    const { ledger } = await expectBridge(w, 9_000);
    expect(payout.netMinor + 1_000 + (await refundShareOf(w)) + n(ledger, 'held')).toBe(50_000);
  });
});
