import { RazorpayWebhookProcessor } from './razorpay-webhook.processor';

/**
 * unit - a live payment leaves a trail you can follow without guessing which table to query.
 *
 * ── WHY THIS MATTERS FOR THE FIRST REAL TRANSACTION ────────────────────────────────
 * The order service logged nothing and this processor logged only failures. So a webhook that
 * arrived, verified and processed correctly left no trace outside the database - and `IGNORED`,
 * the safe outcome for an event we deliberately do not act on, was indistinguishable in a log
 * from a delivery that never arrived at all. Those are exactly the two cases you need to tell
 * apart when the first real customer has just paid and the booking is still PENDING_PAYMENT.
 *
 * These assert the outcome reaches the log, and that the line carries identifiers rather than
 * anything belonging to the buyer.
 */

function makeProcessor(record: Record<string, unknown> | null) {
  const prisma = {
    webhookEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(record),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    refund: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
  };
  const payments = { processVerifiedEvent: jest.fn().mockResolvedValue({ status: 'confirmed' }) };
  const processor = new RazorpayWebhookProcessor(
    prisma as never,
    payments as never,
    { applyRefund: jest.fn(), onTransferFailed: jest.fn() } as never,
    { syncFromWebhook: jest.fn() } as never,
    { record: jest.fn() } as never,
  );
  return { processor };
}

const captured = {
  id: 'w1',
  provider: 'razorpay',
  providerEventId: 'evt_live_1',
  eventType: 'payment.captured',
  attempts: 1,
  payload: {
    object: { payment: { entity: { id: 'pay_1', amount: 150000, notes: { bookingId: 'b1' } } } },
  },
};

describe('a processed webhook says so in the log', () => {
  it('names the outcome, the event type and the provider event id', async () => {
    const { processor } = makeProcessor(captured);
    const logged: string[] = [];
    const logger = (processor as unknown as { logger: { log: (m: string) => void } }).logger;
    jest.spyOn(logger, 'log').mockImplementation((m: string) => void logged.push(m));

    await processor.process('w1');

    expect(logged.join('\n')).toContain('razorpay webhook processed');
    expect(logged.join('\n')).toContain('event=payment.captured');
    expect(logged.join('\n')).toContain('providerEventId=evt_live_1');
  });

  it('distinguishes IGNORED from never arriving', async () => {
    // The safe outcome for an event we do not act on must still be visible.
    const { processor } = makeProcessor({ ...captured, eventType: 'settlement.processed' });
    const logged: string[] = [];
    const logger = (processor as unknown as { logger: { log: (m: string) => void } }).logger;
    jest.spyOn(logger, 'log').mockImplementation((m: string) => void logged.push(m));

    await processor.process('w1');

    expect(logged.join('\n')).toContain('razorpay webhook ignored');
  });

  it('carries no buyer identity', async () => {
    /*
      A log line goes wherever the logs go. Identifiers and money are fine; a name, an email
      or a phone number is not, and the OTP path already applies the same rule.
    */
    const { processor } = makeProcessor(captured);
    const logged: string[] = [];
    const logger = (processor as unknown as { logger: { log: (m: string) => void } }).logger;
    jest.spyOn(logger, 'log').mockImplementation((m: string) => void logged.push(m));

    await processor.process('w1');

    const line = logged.join('\n');
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/\+?\d{10,}/);
  });
});
