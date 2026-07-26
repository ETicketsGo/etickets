import { RazorpayWebhookProcessor } from './razorpay-webhook.processor';

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
  const settlements = {
    applyRefund: jest.fn(),
    onTransferFailed: jest.fn(),
    onTransferReversed: jest.fn(),
  };
  const disputes = { syncFromWebhook: jest.fn() };
  const audit = { record: jest.fn() };
  const processor = new RazorpayWebhookProcessor(
    prisma as never,
    payments as never,
    settlements as never,
    disputes as never,
    audit as never,
  );
  return { processor, prisma, payments, settlements, disputes, updates };
}

const rec = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  provider: 'razorpay',
  providerEventId: 'evt_1',
  eventType: 'payment.captured',
  attempts: 1,
  payload: {
    object: { payment: { entity: { id: 'pay_1', amount: 150000, notes: { bookingId: 'b1' } } } },
  },
  ...over,
});

describe('RazorpayWebhookProcessor idempotency + dispatch', () => {
  it('no-ops when the atomic claim is lost (duplicate delivery)', async () => {
    const { processor, payments } = makeProcessor({ record: rec(), claimCount: 0 });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
  });

  it('payment.captured → issues via processVerifiedEvent (PROCESSED)', async () => {
    const { processor, payments, updates } = makeProcessor({ record: rec() });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment.succeeded',
        bookingId: 'b1',
        amountMinor: 150000,
        providerRef: 'pay_1',
      }),
    );
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PROCESSED' });
  });

  it('order.paid resolves the booking from order receipt/notes', async () => {
    const { processor, payments } = makeProcessor({
      record: rec({
        eventType: 'order.paid',
        payload: {
          object: { order: { entity: { id: 'order_1', amount: 150000, receipt: 'b1' } } },
        },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.succeeded', bookingId: 'b1', amountMinor: 150000 }),
    );
  });

  it('refund.processed deducts the capped organizer share', async () => {
    const { processor, settlements } = makeProcessor({
      record: rec({
        eventType: 'refund.processed',
        payload: {
          object: {
            refund: {
              entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 50000, currency: 'INR' },
            },
          },
        },
      }),
      payment: {
        id: 'p1',
        amountMinor: 150000,
        organizerNetMinor: 140000,
        refundedMinor: 0,
        currency: 'inr',
        booking: { eventId: 'e1' },
      },
    });
    await processor.process('w1');
    // organizer share of a 50000 refund on a 150000 charge with 140000 net = round(50000*140000/150000)=46667
    expect(settlements.applyRefund).toHaveBeenCalledWith('e1', 'INR', 46667);
  });

  it('payment.dispute.lost syncs the dispute with provider=razorpay', async () => {
    const { processor, disputes } = makeProcessor({
      record: rec({
        eventType: 'payment.dispute.lost',
        payload: {
          object: { dispute: { entity: { id: 'disp_1', payment_id: 'pay_1', amount: 150000 } } },
        },
      }),
    });
    await processor.process('w1');
    expect(disputes.syncFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'disp_1', status: 'lost' }),
      'razorpay',
    );
  });

  it('an unhandled event is IGNORED (never dropped)', async () => {
    const { processor, updates } = makeProcessor({
      record: rec({ eventType: 'settlement.processed', payload: { object: {} } }),
    });
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('dead-letters after MAX_ATTEMPTS', async () => {
    const { processor, payments, updates } = makeProcessor({ record: rec({ attempts: 6 }) });
    payments.processVerifiedEvent.mockRejectedValueOnce(new Error('boom'));
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'DEAD_LETTER' });
  });
});
