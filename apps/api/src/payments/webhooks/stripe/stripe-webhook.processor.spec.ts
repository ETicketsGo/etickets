import { StripeWebhookProcessor } from './stripe-webhook.processor';

function makeProcessor(opts: {
  record?: Record<string, unknown> | null;
  claimCount?: number;
  payment?: Record<string, unknown> | null;
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
