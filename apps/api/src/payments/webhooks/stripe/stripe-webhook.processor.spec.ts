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
    object: { metadata: { bookingId: 'b1' }, amount_total: 5000, payment_intent: 'pi_1' },
  },
  ...over,
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
