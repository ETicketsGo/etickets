import { StripeWebhookProcessor } from './stripe-webhook.processor';
import { refundLedgerMemoryDb } from '../../test-support/refund-ledger-memory-db';

function makeProcessor(opts: {
  record?: Record<string, unknown> | null;
  claimCount?: number;
  payment?: Record<string, unknown> | null;
  /** Our COMPLETED Refund rows on the booking, newest first. */
  refundRows?: Array<Record<string, unknown>>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    $transaction: jest.fn(),
    webhookEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(opts.record ?? null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(opts.payment ?? null),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    refund: { findMany: jest.fn().mockResolvedValue(opts.refundRows ?? []) },
  };
  // One transaction is the same mock: the refund path's writes are asserted on it directly.
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const payments = { processVerifiedEvent: jest.fn().mockResolvedValue({ status: 'confirmed' }) };
  const connect = { syncByProviderAccountId: jest.fn().mockResolvedValue(true) };
  const settlements = {
    recordRefund: jest.fn().mockResolvedValue(null),
    reverseRecordedRefund: jest.fn().mockResolvedValue(undefined),
  };
  const disputes = { syncFromWebhook: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const processor = new StripeWebhookProcessor(
    prisma as never,
    payments as never,
    connect as never,
    settlements as never,
    disputes as never,
    audit as never,
  );
  return { processor, prisma, payments, connect, settlements, disputes, audit, updates };
}

const record = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  provider: 'stripe',
  providerEventId: 'evt_1',
  eventType: 'checkout.session.completed',
  attempts: 1,
  payload: {
    object: {
      metadata: { bookingId: 'b1' },
      amount_total: 5000,
      payment_intent: 'pi_1',
      payment_status: 'paid',
    },
  },
  ...over,
});

/*
  A Checkout Session paid by a delayed method completes `unpaid`; the money arrives, or does
  not, days later. Confirming on `completed` alone issued tickets for money that had not moved.
*/
describe('StripeWebhookProcessor — a completed session is not necessarily a paid one', () => {
  const session = (payment_status: string) => ({
    metadata: { bookingId: 'b1' },
    amount_total: 5000,
    payment_intent: 'pi_1',
    payment_status,
  });

  it('does not confirm a session that completed unpaid', async () => {
    const { processor, payments, updates } = makeProcessor({
      record: record({ payload: { object: session('unpaid') } }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('confirms when the delayed payment succeeds', async () => {
    const { processor, payments } = makeProcessor({
      record: record({
        eventType: 'checkout.session.async_payment_succeeded',
        payload: { object: session('paid') },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.succeeded', bookingId: 'b1' }),
    );
  });

  it('fails the booking when the delayed payment fails', async () => {
    const { processor, payments } = makeProcessor({
      record: record({
        eventType: 'checkout.session.async_payment_failed',
        payload: { object: session('unpaid') },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.failed', bookingId: 'b1' }),
    );
  });
});

/*
  Organizer billing runs on the SAME Stripe account as tickets, and the ticket endpoint subscribes
  to checkout.session.completed, so Stripe delivers billing's Checkout Sessions here too. A billing
  session carries the ORGANIZATION id in client_reference_id; read as a booking id it 404'd, retried
  and dead-lettered with a "customer paid, booking not confirmed" alert. Billing has its own
  endpoint (billing/webhooks/stripe); here those sessions are recorded IGNORED.
*/
describe('StripeWebhookProcessor — organizer billing sessions are not ticket payments', () => {
  const billingSession = (mode: string, purpose: string) => ({
    mode,
    client_reference_id: 'org_1',
    metadata: { organizationId: 'org_1', billingAccountId: 'ba_1', etg_purpose: purpose },
    amount_total: 1900,
    payment_intent: null,
    payment_status: 'paid',
  });

  it.each([
    ['checkout.session.completed', 'subscription', 'etg_billing_subscription'],
    ['checkout.session.completed', 'payment', 'etg_billing_credit_pack'],
    ['checkout.session.async_payment_succeeded', 'payment', 'etg_billing_credit_pack'],
    ['checkout.session.async_payment_failed', 'payment', 'etg_billing_credit_pack'],
  ])('%s for a billing %s session is IGNORED', async (eventType, mode, purpose) => {
    const { processor, payments, updates } = makeProcessor({
      record: record({ eventType, payload: { object: billingSession(mode, purpose) } }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('a subscription-mode session is never a ticket payment, whatever its metadata', async () => {
    const { processor, payments } = makeProcessor({
      record: record({
        payload: {
          object: {
            mode: 'subscription',
            client_reference_id: 'x',
            amount_total: 1,
            payment_status: 'paid',
          },
        },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
  });

  it('a ticket session that names its booking only in client_reference_id still confirms', async () => {
    const { processor, payments } = makeProcessor({
      record: record({
        payload: {
          object: {
            mode: 'payment',
            client_reference_id: 'b9',
            amount_total: 5000,
            payment_intent: 'pi_9',
            payment_status: 'paid',
          },
        },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.succeeded', bookingId: 'b9' }),
    );
  });
});

describe('StripeWebhookProcessor.process — idempotency', () => {
  it('no-ops when the atomic claim is lost (duplicate/concurrent delivery)', async () => {
    const { processor, payments, prisma } = makeProcessor({ record: record(), claimCount: 0 });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
  });
});

describe('StripeWebhookProcessor.process — dispatch', () => {
  it('checkout.session.completed → issues via processVerifiedEvent, marks PROCESSED', async () => {
    const { processor, payments, updates } = makeProcessor({ record: record() });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment.succeeded',
        bookingId: 'b1',
        amountMinor: 5000,
        providerRef: 'pi_1',
      }),
    );
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PROCESSED' });
  });

  it('account.updated → syncs the connected account (out-of-order safe, independent)', async () => {
    const { processor, connect, updates } = makeProcessor({
      record: record({
        eventType: 'account.updated',
        payload: {
          object: {
            id: 'acct_1',
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
          },
        },
      }),
    });
    await processor.process('w1');
    expect(connect.syncByProviderAccountId).toHaveBeenCalledWith(
      'acct_1',
      expect.objectContaining({ chargesEnabled: true, payoutsEnabled: true }),
    );
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PROCESSED' });
  });

  it('charge.refunded → deducts the organizer share from the settlement', async () => {
    const { processor, settlements } = makeProcessor({
      record: record({
        eventType: 'charge.refunded',
        payload: {
          object: { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 5000, currency: 'usd' },
        },
      }),
      payment: {
        id: 'p1',
        amountMinor: 10000,
        organizerNetMinor: 8000,
        refundedMinor: 0,
        currency: 'usd',
        booking: { eventId: 'e1' },
      },
    });
    await processor.process('w1');
    // organizer share of a 5000 refund on a 10000 charge with 8000 net = round(5000*8000/10000)=4000
    expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'usd', 4000);
  });

  /*
    R1: the settlement must charge the organizer what the payout ledger charges them -
    `organizerShareOfRefund` (amount - taxAdded - platformFeeRefunded) - whenever our own
    COMPLETED Refund rows explain the refund. Pro-rata is only for dashboard refunds.
  */
  describe('organizer share of a refund (R1)', () => {
    const r1Event = (amountRefunded: number) =>
      record({
        eventType: 'charge.refunded',
        payload: {
          object: {
            id: 'ch_1',
            payment_intent: 'pi_1',
            amount_refunded: amountRefunded,
            currency: 'usd',
          },
        },
      });
    const r1Payment = {
      id: 'p1',
      bookingId: 'b1',
      amountMinor: 105570,
      organizerNetMinor: 100000,
      refundedMinor: 0,
      currency: 'usd',
      booking: { eventId: 'e1' },
    };
    const ownRow = (amountMinor: number, platformFeeRefundedMinor: number) => ({
      amountMinor,
      taxAddedMinor: 0,
      platformFeeRefundedMinor,
    });

    it('a ticket-only refund of 100000 deducts the whole 100000, not 94724', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(100000),
        payment: r1Payment,
        refundRows: [ownRow(100000, 0)],
      });
      await processor.process('w1');
      expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'usd', 100000);
    });

    it('a full cancellation refund returns the fees without charging them to the organizer', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(105570),
        payment: r1Payment,
        refundRows: [ownRow(105570, 5570)],
      });
      await processor.process('w1');
      expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'usd', 100000);
    });

    it('with no Refund row of ours (a dashboard refund) the pro-rata share is kept', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(100000),
        payment: r1Payment,
      });
      await processor.process('w1');
      // round(100000 * 100000 / 105570) = 94724
      expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'usd', 94724);
    });
  });

  it('an unhandled event type is recorded IGNORED (never dropped)', async () => {
    const { processor, updates } = makeProcessor({
      record: record({ eventType: 'invoice.created', payload: { object: {} } }),
    });
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });
});

describe('StripeWebhookProcessor.process — failure/dead-letter', () => {
  it('marks FAILED on a handler error under the attempt cap', async () => {
    const { processor, payments, updates } = makeProcessor({ record: record({ attempts: 2 }) });
    payments.processVerifiedEvent.mockRejectedValueOnce(new Error('db down'));
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'FAILED' });
  });

  it('dead-letters after MAX_ATTEMPTS', async () => {
    const { processor, payments, updates, audit } = makeProcessor({
      record: record({ attempts: 6 }),
    });
    payments.processVerifiedEvent.mockRejectedValueOnce(new Error('still failing'));
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'DEAD_LETTER' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WEBHOOK_DEAD_LETTER' }),
    );
  });
});

/*
  One Stripe test account serves ticket payments AND organizer subscriptions. A dispute on a
  subscription charge also reaches the ticket webhook, and used to create a ticket Dispute row
  with no booking. A dispute is ours only when its payment intent is one of our ticket Payment
  rows; billing disputes are handled by the billing webhook on its own endpoint.
*/
describe('StripeWebhookProcessor — disputes are routed by our own Payment rows', () => {
  const dispute = (over: Record<string, unknown> = {}) => ({
    id: 'dp_1',
    charge: 'ch_1',
    payment_intent: 'pi_1',
    amount: 5000,
    currency: 'usd',
    reason: 'fraudulent',
    status: 'needs_response',
    ...over,
  });
  const disputeEvent = (object: Record<string, unknown>, eventType = 'charge.dispute.created') =>
    record({ eventType, payload: { object } });

  it('a dispute on a subscription charge (no ticket Payment) creates no Dispute and is IGNORED', async () => {
    const { processor, disputes, updates, prisma } = makeProcessor({
      record: disputeEvent(dispute({ payment_intent: 'pi_subscription_invoice' })),
      payment: null,
    });
    await processor.process('w1');
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerPaymentIntentId: 'pi_subscription_invoice' } }),
    );
    expect(disputes.syncFromWebhook).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('a dispute that names no payment intent cannot be verified as ours: IGNORED', async () => {
    const { processor, disputes, updates, prisma } = makeProcessor({
      record: disputeEvent(dispute({ payment_intent: null })),
      payment: { id: 'p1' },
    });
    await processor.process('w1');
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(disputes.syncFromWebhook).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('updated and closed disputes on a subscription charge are IGNORED too', async () => {
    for (const type of ['charge.dispute.updated', 'charge.dispute.closed']) {
      const { processor, disputes, updates } = makeProcessor({
        record: disputeEvent(dispute({ payment_intent: 'pi_sub', status: 'lost' }), type),
        payment: null,
      });
      await processor.process('w1');
      expect(disputes.syncFromWebhook).not.toHaveBeenCalled();
      expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
    }
  });

  it('a dispute on a ticket charge is synced as before and PROCESSED', async () => {
    const obj = dispute();
    const { processor, disputes, updates } = makeProcessor({
      record: disputeEvent(obj),
      payment: { id: 'p1' },
    });
    await processor.process('w1');
    expect(disputes.syncFromWebhook).toHaveBeenCalledWith(obj);
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PROCESSED' });
  });

  it('a duplicate delivery of a dispute is a no-op (the claim is lost)', async () => {
    const { processor, disputes, updates } = makeProcessor({
      record: disputeEvent(dispute()),
      payment: { id: 'p1' },
      claimCount: 0,
    });
    await processor.process('w1');
    expect(disputes.syncFromWebhook).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

/*
  AR-54: `charge.refunded` wrote Payment.refundedMinor and then debited the settlement in a
  separate write. A crash between the two left the settlement undebited forever (the retry saw a
  zero delta), and two deliveries that both read the old refundedMinor both debited it. These run
  the processor against an in-memory payment and settlement with a real rolling-back transaction
  and the REAL SettlementService ledger write.
*/
describe('StripeWebhookProcessor charge.refunded is atomic and counted once (AR-54)', () => {
  const basePayment = {
    id: 'p1',
    bookingId: 'b1',
    amountMinor: 10000,
    organizerNetMinor: 8000,
    refundedMinor: 0,
    currency: 'usd',
    status: 'SUCCEEDED',
    booking: { eventId: 'e1' },
  };
  const baseSettlement = {
    id: 's1',
    eventId: 'e1',
    currency: 'usd',
    provider: 'stripe',
    status: 'ELIGIBLE',
    providerTransferId: null,
    refundsMinor: 0,
  };
  const newDb = () => refundLedgerMemoryDb({ payment: basePayment, settlement: baseSettlement });

  /** One delivery of a charge.refunded event, as its own webhook row, through process(). */
  async function deliver(db: ReturnType<typeof newDb>, eventId: string, amountRefunded: number) {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      ...db.prisma,
      webhookEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(
          record({
            id: eventId,
            eventType: 'charge.refunded',
            payload: {
              object: {
                id: 'ch_1',
                payment_intent: 'pi_1',
                amount_refunded: amountRefunded,
                currency: 'usd',
              },
            },
          }),
        ),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        }),
      },
      // No Refund row of ours: the pro-rata share, 8000/10000 of the refund.
      refund: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const processor = new StripeWebhookProcessor(
      prisma as never,
      {} as never,
      {} as never,
      db.settlements,
      {} as never,
      { record: jest.fn() } as never,
    );
    await processor.process(eventId);
    return updates.at(-1)?.processingStatus;
  }

  it('(a) a single delivery records the refund and debits the organizer share, as before', async () => {
    const db = newDb();
    expect(await deliver(db, 'w1', 5000)).toBe('PROCESSED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 5000, status: 'PARTIALLY_REFUNDED' });
    expect(db.state.settlement.refundsMinor).toBe(4000);
  });

  it('(a) a full refund marks the payment REFUNDED and debits the full organizer net', async () => {
    const db = newDb();
    expect(await deliver(db, 'w1', 10000)).toBe('PROCESSED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 10000, status: 'REFUNDED' });
    expect(db.state.settlement.refundsMinor).toBe(8000);
  });

  it('(b) a duplicate delivery under another event id debits nothing more', async () => {
    const db = newDb();
    await deliver(db, 'w1', 5000);
    expect(await deliver(db, 'w2', 5000)).toBe('PROCESSED');
    expect(db.state.payment.refundedMinor).toBe(5000);
    expect(db.state.settlement.refundsMinor).toBe(4000);
    expect(db.settlementUpdateCalls()).toBe(1);
  });

  it('(b) two concurrent deliveries that both read the old total debit the settlement once', async () => {
    const db = newDb();
    db.raceNextPaymentReads(2);
    const outcomes = await Promise.all([deliver(db, 'w1', 5000), deliver(db, 'w2', 5000)]);

    // One commits; the other loses the compare-and-set, writes nothing, and is left to retry.
    expect([...outcomes].sort()).toEqual(['FAILED', 'PROCESSED']);
    expect(db.state.payment.refundedMinor).toBe(5000);
    expect(db.state.settlement.refundsMinor).toBe(4000);
    expect(db.settlementUpdateCalls()).toBe(1);

    // The retry recomputes from the committed total: nothing left to apply.
    const loser = outcomes[0] === 'FAILED' ? 'w1' : 'w2';
    expect(await deliver(db, loser, 5000)).toBe('PROCESSED');
    expect(db.state.settlement.refundsMinor).toBe(4000);
  });

  it('(b) a concurrent larger refund is not lost: its retry applies only the remainder', async () => {
    const db = newDb();
    db.raceNextPaymentReads(2);
    const [first, second] = await Promise.all([deliver(db, 'w1', 5000), deliver(db, 'w2', 10000)]);
    expect([first, second]).toEqual(['PROCESSED', 'FAILED']);
    expect(db.state.payment.refundedMinor).toBe(5000);

    expect(await deliver(db, 'w2', 10000)).toBe('PROCESSED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 10000, status: 'REFUNDED' });
    expect(db.state.settlement.refundsMinor).toBe(8000);
  });

  it('(c) a failed settlement debit rolls back refundedMinor, and the retry applies it once', async () => {
    const db = newDb();
    db.failNextSettlementUpdates(1);
    expect(await deliver(db, 'w1', 5000)).toBe('FAILED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 0, status: 'SUCCEEDED' });
    expect(db.state.settlement.refundsMinor).toBe(0);

    // Before AR-54 the retry saw a zero delta here and the settlement was never debited.
    expect(await deliver(db, 'w1', 5000)).toBe('PROCESSED');
    expect(db.state.payment.refundedMinor).toBe(5000);
    expect(db.state.settlement.refundsMinor).toBe(4000);
  });
});
