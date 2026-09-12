import { RazorpayWebhookProcessor } from './razorpay-webhook.processor';

function makeProcessor(opts: {
  record?: Record<string, unknown> | null;
  claimCount?: number;
  payment?: Record<string, unknown> | null;
  /** Our Refund row carrying the Razorpay refund id, if any. */
  refundRow?: Record<string, unknown> | null;
  /** A refund of ours on the booking that has been claimed but not yet recorded. */
  inFlight?: Record<string, unknown> | null;
  /** Another delivery of `refund.processed` for the same Razorpay refund. */
  sibling?: Record<string, unknown> | null;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    webhookEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(opts.record ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.sibling ?? null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
    payment: { findFirst: jest.fn().mockResolvedValue(opts.payment ?? null), update: jest.fn() },
    refund: {
      findFirst: jest.fn(async ({ where }: { where: { providerRef?: string | null } }) =>
        where.providerRef === null ? (opts.inFlight ?? null) : (opts.refundRow ?? null),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
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
  return { processor, prisma, payments, settlements, disputes, audit, updates };
}

const refundEvent = (eventType: string) =>
  rec({
    eventType,
    payload: {
      object: {
        refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 50000, currency: 'INR' } },
      },
    },
  });

const capturedPayment = {
  id: 'p1',
  bookingId: 'b1',
  amountMinor: 150000,
  organizerNetMinor: 140000,
  refundedMinor: 0,
  currency: 'inr',
  booking: { eventId: 'e1' },
};

/*
  Both `refund.created` and `refund.processed` added the refund to `refundedMinor` and deducted
  it from the settlement, so every Razorpay refund was counted twice.
*/
describe('RazorpayWebhookProcessor refunds are counted once', () => {
  it('refund.created moves nothing — the refund has not been paid yet', async () => {
    const { processor, prisma, settlements, updates } = makeProcessor({
      record: refundEvent('refund.created'),
      payment: capturedPayment,
    });
    await processor.process('w1');
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(settlements.applyRefund).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('a second delivery of refund.processed for the same refund does not deduct again', async () => {
    const { processor, prisma, settlements } = makeProcessor({
      record: refundEvent('refund.processed'),
      payment: capturedPayment,
      sibling: { id: 'w0' },
    });
    await processor.process('w1');
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(settlements.applyRefund).not.toHaveBeenCalled();
  });

  it('refund.processed finalises our PROCESSING refund row to COMPLETED', async () => {
    const { processor, prisma } = makeProcessor({
      record: refundEvent('refund.processed'),
      payment: capturedPayment,
      refundRow: { id: 'rf-1', bookingId: 'b1', organizationId: 'org-1', amountMinor: 50000 },
    });
    await processor.process('w1');
    expect(prisma.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'rf-1', status: { in: ['PROCESSING'] } },
      data: { status: 'COMPLETED' },
    });
  });

  it('retries, without touching the ledger, while our refund is still being recorded', async () => {
    const { processor, prisma, settlements, updates } = makeProcessor({
      record: refundEvent('refund.processed'),
      payment: capturedPayment,
      inFlight: { id: 'rf-1' },
    });
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'FAILED' });
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(settlements.applyRefund).not.toHaveBeenCalled();
  });

  it('refund.failed marks our refund FAILED and records it for manual follow-up', async () => {
    const { processor, prisma, audit, updates } = makeProcessor({
      record: refundEvent('refund.failed'),
      payment: capturedPayment,
      refundRow: { id: 'rf-1', bookingId: 'b1', organizationId: 'org-1', amountMinor: 50000 },
    });
    await processor.process('w1');
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'rf-1' }),
        data: { status: 'FAILED' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REFUND_FAILED_AT_PROVIDER', entityId: 'rf-1' }),
    );
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PROCESSED' });
  });
});

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

  it('payment.failed carries WHY it failed, as our reason and Razorpay’s token', async () => {
    /*
      The QA refusal, verbatim from the Razorpay API. It used to be reduced to "failed" and the
      buyer was told to try the same card again.
    */
    const { processor, payments } = makeProcessor({
      record: rec({
        eventType: 'payment.failed',
        payload: {
          object: {
            payment: {
              entity: {
                id: 'pay_f1',
                amount: 52282,
                notes: { bookingId: 'b1' },
                error_code: 'BAD_REQUEST_ERROR',
                error_reason: 'international_transaction_not_allowed',
                error_description: 'This business accepts domestic (Indian) card payments only.',
                error_source: 'business',
                error_step: 'payment_initiation',
              },
            },
          },
        },
      }),
    });
    await processor.process('w1');
    const event = payments.processVerifiedEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'payment.failed',
      bookingId: 'b1',
      failure: {
        reason: 'INTERNATIONAL_CARD_NOT_ACCEPTED',
        providerCode: 'international_transaction_not_allowed',
      },
    });
    // The provider's prose is for merchants and changes without notice; it is not kept.
    expect(JSON.stringify(event)).not.toContain('domestic (Indian)');
  });

  it('a successful payment carries no failure', async () => {
    const { processor, payments } = makeProcessor({ record: rec() });
    await processor.process('w1');
    expect(payments.processVerifiedEvent.mock.calls[0][0]).not.toHaveProperty('failure');
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
