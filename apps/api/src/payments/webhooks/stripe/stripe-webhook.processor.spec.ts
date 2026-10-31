import { StripeWebhookProcessor } from './stripe-webhook.processor';

function makeProcessor(opts: {
  record?: Record<string, unknown> | null;
  claimCount?: number;
  payment?: Record<string, unknown> | null;
  /** Our COMPLETED Refund rows on the booking, newest first. */
  refundRows?: Array<Record<string, unknown>>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    webhookEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(opts.record ?? null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
    payment: { findFirst: jest.fn().mockResolvedValue(opts.payment ?? null), update: jest.fn() },
    refund: { findMany: jest.fn().mockResolvedValue(opts.refundRows ?? []) },
  };
  const payments = { processVerifiedEvent: jest.fn().mockResolvedValue({ status: 'confirmed' }) };
  const connect = { syncByProviderAccountId: jest.fn().mockResolvedValue(true) };
  const settlements = { applyRefund: jest.fn().mockResolvedValue(undefined) };
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
    expect(settlements.applyRefund).toHaveBeenCalledWith('e1', 'usd', 4000);
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
      expect(settlements.applyRefund).toHaveBeenCalledWith('e1', 'usd', 100000);
    });

    it('a full cancellation refund returns the fees without charging them to the organizer', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(105570),
        payment: r1Payment,
        refundRows: [ownRow(105570, 5570)],
      });
      await processor.process('w1');
      expect(settlements.applyRefund).toHaveBeenCalledWith('e1', 'usd', 100000);
    });

    it('with no Refund row of ours (a dashboard refund) the pro-rata share is kept', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(100000),
        payment: r1Payment,
      });
      await processor.process('w1');
      // round(100000 * 100000 / 105570) = 94724
      expect(settlements.applyRefund).toHaveBeenCalledWith('e1', 'usd', 94724);
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
