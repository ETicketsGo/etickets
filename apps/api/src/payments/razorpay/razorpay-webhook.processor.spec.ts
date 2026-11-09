import { RazorpayWebhookProcessor } from './razorpay-webhook.processor';
import { refundLedgerMemoryDb } from '../test-support/refund-ledger-memory-db';

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
    $transaction: jest.fn(),
    webhookEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(opts.record ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.sibling ?? null),
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
    refund: {
      findFirst: jest.fn(async ({ where }: { where: { providerRef?: string | null } }) =>
        where.providerRef === null ? (opts.inFlight ?? null) : (opts.refundRow ?? null),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  // One transaction is the same mock: the refund path's writes are asserted on it directly.
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const payments = { processVerifiedEvent: jest.fn().mockResolvedValue({ status: 'confirmed' }) };
  const settlements = {
    recordRefund: jest.fn().mockResolvedValue(null),
    reverseRecordedRefund: jest.fn().mockResolvedValue(undefined),
    onTransferFailed: jest.fn(),
    applyTransferEvidence: jest.fn().mockResolvedValue({ kind: 'AGREES' }),
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
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(settlements.recordRefund).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('a second delivery of refund.processed for the same refund does not deduct again', async () => {
    const { processor, prisma, settlements } = makeProcessor({
      record: refundEvent('refund.processed'),
      payment: capturedPayment,
      sibling: { id: 'w0' },
    });
    await processor.process('w1');
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(settlements.recordRefund).not.toHaveBeenCalled();
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
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(settlements.recordRefund).not.toHaveBeenCalled();
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

  it('payment.captured carries the currency of the payment, for the confirm check', async () => {
    const { processor, payments } = makeProcessor({
      record: rec({
        payload: {
          object: {
            payment: {
              entity: { id: 'pay_1', amount: 150000, currency: 'INR', notes: { bookingId: 'b1' } },
            },
            // An order in another currency must not be read as the payment's.
            order: { entity: { id: 'order_1', amount: 150000, currency: 'USD', receipt: 'b1' } },
          },
        },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent.mock.calls[0][0]).toMatchObject({ currency: 'INR' });
  });

  it('order.paid with no payment entity reads the order currency', async () => {
    const { processor, payments } = makeProcessor({
      record: rec({
        eventType: 'order.paid',
        payload: {
          object: {
            order: { entity: { id: 'order_1', amount: 150000, currency: 'INR', receipt: 'b1' } },
          },
        },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent.mock.calls[0][0]).toMatchObject({ currency: 'INR' });
  });

  it('a payload with no currency adds none (nothing to check)', async () => {
    const { processor, payments } = makeProcessor({ record: rec() });
    await processor.process('w1');
    expect(payments.processVerifiedEvent.mock.calls[0][0]).not.toHaveProperty('currency');
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
    expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'INR', 46667);
  });

  /*
    R1: the settlement must charge the organizer what the payout ledger charges them -
    `organizerShareOfRefund` (amount - taxAdded - platformFeeRefunded) - whenever our own
    COMPLETED Refund row explains the refund. Pro-rata is only for dashboard refunds.
  */
  describe('organizer share of a refund (R1)', () => {
    const r1Event = (amount: number) =>
      rec({
        eventType: 'refund.processed',
        payload: {
          object: {
            refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount, currency: 'INR' } },
          },
        },
      });
    const r1Payment = {
      id: 'p1',
      bookingId: 'b1',
      amountMinor: 105570,
      organizerNetMinor: 100000,
      refundedMinor: 0,
      currency: 'inr',
      booking: { eventId: 'e1' },
    };
    const ownRow = (amountMinor: number, platformFeeRefundedMinor: number) => ({
      id: 'rf-1',
      bookingId: 'b1',
      organizationId: 'org-1',
      status: 'COMPLETED',
      amountMinor,
      taxAddedMinor: 0,
      platformFeeRefundedMinor,
    });

    it('a ticket-only refund of 100000 deducts the whole 100000, not 94724', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(100000),
        payment: r1Payment,
        refundRow: ownRow(100000, 0),
      });
      await processor.process('w1');
      expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'INR', 100000);
    });

    it('a full cancellation refund returns the fees without charging them to the organizer', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(105570),
        payment: r1Payment,
        refundRow: ownRow(105570, 5570),
      });
      await processor.process('w1');
      expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'INR', 100000);
    });

    it('with no Refund row of ours (a dashboard refund) the pro-rata share is kept', async () => {
      const { processor, settlements } = makeProcessor({
        record: r1Event(100000),
        payment: r1Payment,
      });
      await processor.process('w1');
      // round(100000 * 100000 / 105570) = 94724
      expect(settlements.recordRefund).toHaveBeenCalledWith(expect.anything(), 'e1', 'INR', 94724);
    });
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

  /*
    A capture we cannot attribute to a booking.

    `toPaymentEvent` resolves the booking from `payment.notes.bookingId`, then
    `order.notes.bookingId`, then `order.receipt`. With none of them it returns null - and the
    only safe thing to do with real money we cannot attribute is to record the event and touch
    nothing. Confirming a guess would issue somebody else's tickets; throwing would retry to
    the dead-letter and still never resolve.
  */
  it('IGNORES a captured payment that names no booking, rather than guessing one', async () => {
    const { processor, payments, updates } = makeProcessor({
      record: rec({
        payload: { object: { payment: { entity: { id: 'pay_x', amount: 150000, notes: {} } } } },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('IGNORES a capture whose amount is not a number', async () => {
    // Razorpay types some money fields as number | string; a string here must not be confirmed.
    const { processor, payments, updates } = makeProcessor({
      record: rec({
        payload: {
          object: {
            payment: { entity: { id: 'pay_y', amount: '150000', notes: { bookingId: 'b1' } } },
          },
        },
      }),
    });
    await processor.process('w1');
    expect(payments.processVerifiedEvent).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'IGNORED' });
  });

  it('dead-letters after MAX_ATTEMPTS', async () => {
    const { processor, payments, updates } = makeProcessor({ record: rec({ attempts: 6 }) });
    payments.processVerifiedEvent.mockRejectedValueOnce(new Error('boom'));
    await processor.process('w1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'DEAD_LETTER' });
  });
});

/*
  ── R4: THE WEBHOOK NO LONGER INVENTS ACCOUNTING ──────────────────────────────
  `transfer.reversed` used to call `onTransferReversed(transferId)` - a transfer id and nothing
  else. It set the settlement to REVERSED whatever amount had come back, never touched the money,
  and discarded the cumulative `amount_reversed` the payload was already carrying.

  There was no test for any of it. The stub existed and nothing ever sent the event, which is how
  a path that wrote contradictory money facts stayed invisible.
*/
const reversedEvent = (entity: Record<string, unknown>) =>
  rec({
    providerEventId: 'evt_rev_1',
    eventType: 'transfer.reversed',
    payload: { object: { transfer: { entity } } },
  });

describe('RazorpayWebhookProcessor transfer.reversed carries the amount', () => {
  it('passes the cumulative reversed figure to the one reconciliation engine', async () => {
    const { processor, settlements } = makeProcessor({
      record: reversedEvent({
        id: 'trf_1',
        amount: 100_000,
        amount_reversed: 30_000,
        currency: 'inr',
        status: 'partially_reversed',
      }),
    });

    await processor.process('w1');

    expect(settlements.applyTransferEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'razorpay',
        providerTransferId: 'trf_1',
        currency: 'inr',
        originalTransferredMinor: 100_000,
        cumulativeReversedMinor: 30_000,
        providerStatusRaw: 'partially_reversed',
        source: 'WEBHOOK',
      }),
    );
  });

  it('does not treat a PARTIAL reversal as a full one', async () => {
    /*
      The old handler had no way to tell the difference - it set REVERSED either way. Now the
      amount travels with the evidence and the engine decides, so a partial cannot present as a
      full reversal.
    */
    const { processor, settlements } = makeProcessor({
      record: reversedEvent({
        id: 'trf_1',
        amount: 100_000,
        amount_reversed: 30_000,
        currency: 'inr',
        status: 'partially_reversed',
      }),
    });

    await processor.process('w1');

    const evidence = settlements.applyTransferEvidence.mock.calls[0][0];
    expect(evidence.cumulativeReversedMinor).toBe(30_000);
    expect(evidence.cumulativeReversedMinor).toBeLessThan(evidence.originalTransferredMinor);
  });

  it('reads nothing as zero rather than guessing when the payload omits the amount', async () => {
    // A payload shape we have not met must not become a reversal of unknown size.
    const { processor, settlements } = makeProcessor({
      record: reversedEvent({ id: 'trf_1', currency: 'inr' }),
    });

    await processor.process('w1');

    expect(settlements.applyTransferEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ cumulativeReversedMinor: 0, originalTransferredMinor: null }),
    );
  });

  it('ignores an event with no transfer id rather than acting on it', async () => {
    const { processor, settlements } = makeProcessor({
      record: reversedEvent({ currency: 'inr' }),
    });

    await processor.process('w1');

    expect(settlements.applyTransferEvidence).not.toHaveBeenCalled();
  });

  it('never sets a settlement status directly', async () => {
    /*
      The structural claim of R4: this processor has no path to a settlement write at all. It
      produces evidence; the engine decides what that means.
    */
    const { processor, prisma } = makeProcessor({
      record: reversedEvent({ id: 'trf_1', amount_reversed: 100_000, currency: 'inr' }),
    });

    await processor.process('w1');

    expect((prisma as Record<string, unknown>).settlement).toBeUndefined();
  });
});

/*
  AR-54: `refund.processed` wrote Payment.refundedMinor and then debited the settlement in a
  separate write. A crash between the two left the settlement undebited, and two deliveries that
  both read the old refundedMinor both debited it (and the later one overwrote the earlier one's
  refundedMinor). These run the processor against an in-memory payment and settlement with a real
  rolling-back transaction and the REAL SettlementService ledger write.
*/
describe('RazorpayWebhookProcessor refund.processed is atomic and counted once (AR-54)', () => {
  const basePayment = {
    id: 'p1',
    bookingId: 'b1',
    amountMinor: 150000,
    organizerNetMinor: 140000,
    refundedMinor: 0,
    currency: 'inr',
    status: 'SUCCEEDED',
    booking: { eventId: 'e1' },
  };
  const baseSettlement = {
    id: 's1',
    eventId: 'e1',
    currency: 'inr',
    provider: 'razorpay',
    status: 'ELIGIBLE',
    providerTransferId: null,
    refundsMinor: 0,
  };
  const newDb = () => refundLedgerMemoryDb({ payment: basePayment, settlement: baseSettlement });

  /**
   * One delivery of refund.processed, as its own webhook row, through process(). `sibling` is
   * what the once-per-Razorpay-refund lookup finds: another delivery already handled.
   */
  async function deliver(
    db: ReturnType<typeof newDb>,
    eventId: string,
    refund: { id: string; amount: number },
    sibling: { id: string } | null = null,
  ) {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      ...db.prisma,
      webhookEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(
          rec({
            id: eventId,
            eventType: 'refund.processed',
            payload: {
              object: {
                refund: { entity: { ...refund, payment_id: 'pay_1', currency: 'INR' } },
              },
            },
          }),
        ),
        findFirst: jest.fn().mockResolvedValue(sibling),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        }),
      },
      // No Refund row of ours (a dashboard refund): the pro-rata share, 140000/150000.
      refund: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const processor = new RazorpayWebhookProcessor(
      prisma as never,
      {} as never,
      db.settlements,
      {} as never,
      { record: jest.fn() } as never,
    );
    await processor.process(eventId);
    return updates.at(-1)?.processingStatus;
  }

  const r1 = { id: 'rfnd_1', amount: 50000 };
  const r2 = { id: 'rfnd_2', amount: 30000 };

  it('(a) a single delivery records the refund and debits the organizer share, as before', async () => {
    const db = newDb();
    expect(await deliver(db, 'w1', r1)).toBe('PROCESSED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 50000, status: 'PARTIALLY_REFUNDED' });
    // round(50000 * 140000 / 150000) = 46667, exactly what applyRefund was called with before.
    expect(db.state.settlement.refundsMinor).toBe(46667);
  });

  it('(a) a refund is still capped at the captured amount', async () => {
    const db = newDb();
    expect(await deliver(db, 'w1', { id: 'rfnd_big', amount: 200000 })).toBe('PROCESSED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 150000, status: 'REFUNDED' });
    expect(db.state.settlement.refundsMinor).toBe(140000);
  });

  it('(b) two concurrent deliveries of the same refund debit the settlement once', async () => {
    const db = newDb();
    db.raceNextPaymentReads(2);
    // Neither delivery has seen the other yet: only the payment compare-and-set stands between them.
    const outcomes = await Promise.all([deliver(db, 'w1', r1), deliver(db, 'w2', r1)]);
    expect([...outcomes].sort()).toEqual(['FAILED', 'PROCESSED']);
    expect(db.state.payment.refundedMinor).toBe(50000);
    expect(db.state.settlement.refundsMinor).toBe(46667);
    expect(db.settlementUpdateCalls()).toBe(1);

    // The loser's retry finds the winner's handled delivery and applies nothing.
    const loser = outcomes[0] === 'FAILED' ? 'w1' : 'w2';
    const winner = loser === 'w1' ? 'w2' : 'w1';
    expect(await deliver(db, loser, r1, { id: winner })).toBe('PROCESSED');
    expect(db.state.payment.refundedMinor).toBe(50000);
    expect(db.state.settlement.refundsMinor).toBe(46667);
  });

  it('(b) two different refunds racing are both counted, each exactly once', async () => {
    const db = newDb();
    db.raceNextPaymentReads(2);
    const [first, second] = await Promise.all([deliver(db, 'w1', r1), deliver(db, 'w2', r2)]);
    // Before AR-54 both debited and the second overwrote refundedMinor with 30000.
    expect([first, second]).toEqual(['PROCESSED', 'FAILED']);
    expect(db.state.payment.refundedMinor).toBe(50000);

    expect(await deliver(db, 'w2', r2)).toBe('PROCESSED');
    expect(db.state.payment.refundedMinor).toBe(80000);
    // 46667 + round(30000 * 140000 / 150000) = 46667 + 28000
    expect(db.state.settlement.refundsMinor).toBe(74667);
  });

  it('(c) a failed settlement debit rolls back refundedMinor, and the retry applies it once', async () => {
    const db = newDb();
    db.failNextSettlementUpdates(1);
    expect(await deliver(db, 'w1', r1)).toBe('FAILED');
    expect(db.state.payment).toMatchObject({ refundedMinor: 0, status: 'SUCCEEDED' });
    expect(db.state.settlement.refundsMinor).toBe(0);

    expect(await deliver(db, 'w1', r1)).toBe('PROCESSED');
    expect(db.state.payment.refundedMinor).toBe(50000);
    expect(db.state.settlement.refundsMinor).toBe(46667);
  });
});
