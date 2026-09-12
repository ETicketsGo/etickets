import {
  BookingStatus,
  ExperienceType,
  PaymentAttemptStatus,
  PaymentStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { PaymentsService } from './payments.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { PaymentEvent } from './provider/payment-provider.interface';
import { MetricsService } from '../metrics/metrics.service';
import { BookingReferenceService } from '../bookings/booking-reference.service';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';

const SUCCEEDED_EVENT: PaymentEvent = {
  type: 'payment.succeeded',
  providerRef: 'mock_pi_123',
  bookingId: 'b1',
  amountMinor: 5000,
};

interface BookingShape {
  id: string;
  status: string;
  eventSessionId: string;
  organizationId: string;
  buyerName: string;
  buyerEmail: string;
  userId: string | null;
  holdExpiresAt: Date;
  couponId?: string | null;
  currency?: string;
  totalMinor: number;
  items: Array<{ ticketTypeId: string; quantity: number }>;
  event: { experienceType: string; venue: { country: string } | null };
}

/** The booking's payment as confirm() leaves it: captured under the event's reference. */
const APPLIED_PAYMENT = {
  id: 'pay-row-1',
  provider: 'razorpay',
  status: PaymentStatus.SUCCEEDED,
  providerRef: 'mock_pi_123',
  providerPaymentIntentId: 'mock_pi_123',
  providerOrderId: 'order_1',
};

/** A tx mock exposing exactly the writes confirm() performs. */
function makeTx(claimCount: number) {
  return {
    booking: {
      updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      update: jest.fn().mockResolvedValue({}),
    },
    bookingReferenceCounter: {
      upsert: jest.fn().mockResolvedValue({ scope: 'IND-2026', value: 7 }),
    },
    ticket: { create: jest.fn().mockResolvedValue({}) },
    payment: { update: jest.fn().mockResolvedValue({}) },
    paymentAttempt: { create: jest.fn().mockResolvedValue({}) },
    coupon: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // Stands in for Prisma's column reference, so the compare is visible in assertions.
      fields: { maxRedemptions: 'Coupon.maxRedemptions' },
    },
  };
}

/**
 * Builds the collaborators for confirm(). `claimCount` controls the atomic
 * PENDING_PAYMENT→CONFIRMED claim; `specs` is what the strategy.confirm returns.
 */
function setup(opts: {
  booking: BookingShape | null;
  claimCount?: number;
  specs?: Array<{ ticketTypeId: string; seatId?: string; seatLabel?: string }>;
  /** The booking's Payment row as read outside the confirm transaction. */
  payment?: Record<string, unknown> | null;
}) {
  const tx = makeTx(opts.claimCount ?? 1);
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue(opts.booking),
      // Only ever called if something stamps the booking outside the confirm transaction.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Written outside a transaction by fail(), which confirms nothing.
    payment: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.payment === undefined ? APPLIED_PAYMENT : opts.payment),
    },
    paymentAttempt: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const finance = { fileDiscrepancy: jest.fn().mockResolvedValue(true) };
  const strategy = {
    confirm: jest.fn().mockResolvedValue(opts.specs ?? []),
  };
  const provider = { verifyWebhook: jest.fn().mockResolvedValue(SUCCEEDED_EVENT) };
  const mockProvider = {
    signEvent: jest.fn((e) => ({ rawBody: JSON.stringify(e), signature: 'x' })),
  };
  const orchestrator = {
    createPayment: jest
      .fn()
      .mockResolvedValue({ intent: { providerRef: 'mock_pi_123' }, provider: 'mock' }),
    refund: jest.fn().mockResolvedValue({ providerRef: 'mock_rf_1', status: 'COMPLETED' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    // Critical notifications are written IN the domain transaction now, so the stub
    // captures the transaction client it was handed -- that IS the assertion.
    sendCritical: jest.fn().mockResolvedValue(undefined),
    fanOutCritical: jest.fn().mockResolvedValue(0),
  };
  const inventory = { forSeating: jest.fn().mockReturnValue(strategy) };
  const config = { get: jest.fn().mockReturnValue('LOCAL') };
  const settlements = { onPaymentSucceeded: jest.fn().mockResolvedValue(undefined) };
  const razorpayOrders = { createOrder: jest.fn(), verify: jest.fn() };
  const eventPublisher = {
    recordInTransaction: jest.fn().mockResolvedValue(0),
    deliverAfterCommit: jest.fn().mockResolvedValue(undefined),
  };

  const service = new PaymentsService(
    prisma as never,
    provider as never,
    mockProvider as never,
    orchestrator as never,
    /*
      The resolver. The marketplace gate used to ask the GLOBALLY configured provider
      whether it supported transfers — which is the mock — so the gate refusing a paid
      booking from an organizer with no charges-enabled account was skipped entirely, and a
      USD charge would have gone to Stripe with nothing tying it to an organizer. It now
      asks the provider that will actually take the money.
    */
    { get: jest.fn().mockReturnValue(provider) } as never,
    audit as never,
    notifications as never,
    inventory as never,
    new AddOnInventoryService(),
    new MetricsService(),
    new BookingReferenceService(),
    { issueForBooking: jest.fn().mockResolvedValue(undefined) } as never,
    config as never,
    settlements as never,
    razorpayOrders as never,
    eventPublisher as never,
    { onConfirmed: async () => undefined, preConfirm: async () => ({ handled: false }) } as never,
    finance as never,
  );
  return {
    service,
    prisma,
    tx,
    strategy,
    provider,
    audit,
    notifications,
    inventory,
    eventPublisher,
    finance,
    orchestrator,
    razorpayOrders,
  };
}

const pendingBooking = (over: Partial<BookingShape> = {}): BookingShape => ({
  id: 'b1',
  status: BookingStatus.PENDING_PAYMENT,
  eventSessionId: 'sess-1',
  organizationId: 'org-1',
  buyerName: 'Ada',
  buyerEmail: 'ada@example.test',
  userId: 'u1',
  holdExpiresAt: new Date(Date.now() + 60_000),
  couponId: null,
  totalMinor: 5000,
  items: [{ ticketTypeId: 't1', quantity: 2 }],
  event: { experienceType: ExperienceType.EVENT, venue: { country: 'India' } },
  ...over,
});

const webhook = { rawBody: '{}', signature: 'sig' };

/*
  Found by QA: a booking whose order was opened on Razorpay and then settled through the dev-only
  mock-pay path kept `provider: razorpay` with an uncaptured order id. Refunds go to the provider
  the payment names, so every organizer refund on QA was sent to Razorpay and failed.
*/
describe('PaymentsService.mockPay', () => {
  const ENV_KEYS = ['APP_ENV', 'PAYMENT_PROVIDER_NAME', 'PAYMENTS_MOCK_ENABLED'] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    // The mock is allowed only locally with the mock provider — read when the service is built.
    process.env.APP_ENV = 'LOCAL';
    delete process.env.PAYMENT_PROVIDER_NAME;
    delete process.env.PAYMENTS_MOCK_ENABLED;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const openedOnRazorpay = {
    ...APPLIED_PAYMENT,
    status: PaymentStatus.PROCESSING,
    amountMinor: 5000,
  };

  it('records a payment the mock settled as a mock payment, before confirming it', async () => {
    const { service, prisma } = setup({ booking: pendingBooking(), payment: openedOnRazorpay });
    const handle = jest
      .spyOn(service, 'handleWebhook')
      .mockResolvedValue({ status: 'confirmed' } as never);

    await service.mockPay('b1', 'succeeded');

    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { bookingId: 'b1' },
      data: { provider: 'mock' },
    });
    // Relabelled first, so everything downstream — the refund route included — reads the mock.
    expect(prisma.payment.update.mock.invocationCallOrder[0]).toBeLessThan(
      handle.mock.invocationCallOrder[0],
    );
  });

  it('leaves the provider alone when the mock reports a failure', async () => {
    const { service, prisma } = setup({ booking: pendingBooking(), payment: openedOnRazorpay });
    jest.spyOn(service, 'handleWebhook').mockResolvedValue({ status: 'failed' } as never);

    await service.mockPay('b1', 'failed');

    expect(prisma.payment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { provider: 'mock' } }),
    );
  });
});

describe('PaymentsService.fail (via handleWebhook)', () => {
  const FAILED_EVENT: PaymentEvent = {
    type: 'payment.failed',
    providerRef: 'pay_f1',
    bookingId: 'b1',
    amountMinor: 52_282,
    failure: {
      reason: 'INTERNATIONAL_CARD_NOT_ACCEPTED',
      providerCode: 'international_transaction_not_allowed',
    },
  };
  const unpaid = () =>
    ({
      ...pendingBooking({ totalMinor: 52_282 }),
      reference: null,
      currency: 'INR',
      holdExpiresAt: new Date('2026-09-11T21:05:00.000Z'),
      event: {
        experienceType: ExperienceType.MOVIE,
        title: 'Kantara Chapter 1',
        venue: { country: 'India', timezone: 'Asia/Kolkata' },
      },
      eventSession: { startsAt: new Date('2026-09-12T14:30:00.000Z'), screen: null },
    }) as unknown as BookingShape;

  it('tells the buyer what failed, how much, why and until when — never the database id', async () => {
    const { service, provider, prisma, notifications } = setup({ booking: unpaid() });
    provider.verifyWebhook.mockResolvedValue(FAILED_EVENT);

    await service.handleWebhook(webhook);

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.FAILED } }),
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const sent = notifications.send.mock.calls[0][0];
    expect(sent.payload).toMatchObject({
      eventTitle: 'Kantara Chapter 1',
      startsAt: '2026-09-12T14:30:00.000Z',
      timeZone: 'Asia/Kolkata',
      amountMinor: 52_282,
      currency: 'INR',
      reason: 'INTERNATIONAL_CARD_NOT_ACCEPTED',
      heldUntil: '2026-09-11T21:05:00.000Z',
    });
  });

  it('is ONE notification per booking, however many attempts fail', async () => {
    /*
      QA received two identical "Payment failed" messages for two attempts on one booking. The
      intent key is per booking, so the notification layer collapses the second.
    */
    const { service, provider, notifications } = setup({ booking: unpaid() });
    provider.verifyWebhook.mockResolvedValue(FAILED_EVENT);
    await service.handleWebhook(webhook);
    await service.handleWebhook(webhook);
    const keys = notifications.send.mock.calls.map(([input]) => input.intentKey);
    expect(new Set(keys)).toEqual(new Set(['payment-failed:b1']));
  });

  it('does not tell somebody holding tickets that their payment failed', async () => {
    /*
      A refused card, then net banking that succeeded: the refusal's webhook can arrive after
      the booking is confirmed. The attempt is recorded; the payment and the buyer are left alone.
    */
    const confirmed = { ...unpaid(), status: BookingStatus.CONFIRMED } as BookingShape;
    const { service, provider, prisma, notifications } = setup({ booking: confirmed });
    provider.verifyWebhook.mockResolvedValue(FAILED_EVENT);

    await service.handleWebhook(webhook);

    expect(prisma.paymentAttempt.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.confirm (via handleWebhook)', () => {
  it('confirms a pending booking: issues N tickets, marks SUCCEEDED, records attempt', async () => {
    const { service, tx, prisma, notifications, audit, eventPublisher } = setup({
      booking: pendingBooking(),
      claimCount: 1,
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });

    const result = await service.handleWebhook(webhook);

    expect(result).toEqual({ status: 'confirmed', bookingId: 'b1', tickets: 2 });
    // Atomic claim scoped to PENDING_PAYMENT.
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b1', status: BookingStatus.PENDING_PAYMENT },
        data: expect.objectContaining({ status: BookingStatus.CONFIRMED }),
      }),
    );
    // The immutable public reference is assigned inside the confirm transaction.
    expect(tx.bookingReferenceCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: expect.stringMatching(/^IND-\d{4}$/) } }),
    );
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b1' },
        data: { reference: expect.stringMatching(/^ETG-IND-\d{4}-000007$/) },
      }),
    );
    // One ticket per spec unit.
    expect(tx.ticket.create).toHaveBeenCalledTimes(2);
    expect(tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TicketStatus.ACTIVE, bookingId: 'b1' }),
      }),
    );
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.SUCCEEDED }),
      }),
    );
    expect(tx.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentAttemptStatus.SUCCEEDED }),
      }),
    );
    // No coupon on this booking.
    expect(tx.coupon.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    /*
      Written INSIDE the confirm transaction, on the same client that issued the tickets.

      Enqueued after the commit there is a window -- money taken, booking confirmed, process
      dies -- in which the one message carrying somebody's ticket is lost permanently,
      because nothing recorded that it was owed. Passing `tx` is what closes it, and passing
      the SAME tx is what makes "confirmed" and "told" one fact.
    */
    expect(notifications.sendCritical).toHaveBeenCalledTimes(1);
    expect(notifications.sendCritical.mock.calls[0][0]).toBe(tx);
    expect(notifications.send).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    // ADR-041 proof slice: the BookingConfirmed fact is recorded IN the confirm tx
    // (durable in outbox mode; no-op in_process) and delivered exactly once after commit,
    // with a PII-free payload.
    expect(eventPublisher.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(eventPublisher.deliverAfterCommit).toHaveBeenCalledTimes(1);
    const recorded = (eventPublisher.recordInTransaction as jest.Mock).mock.calls[0][1][0];
    expect(recorded).toMatchObject({
      eventType: 'booking.confirmed',
      aggregateType: 'Booking',
      aggregateId: 'b1',
      payload: expect.objectContaining({ bookingId: 'b1', ticketCount: 2 }),
    });
    expect(recorded.payload).not.toHaveProperty('buyerEmail');
  });

  it('increments the coupon redemption count when the booking used a coupon', async () => {
    const { service, tx } = setup({
      booking: pendingBooking({ couponId: 'cpn-1' }),
      claimCount: 1,
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });
    await service.handleWebhook(webhook);
    expect(tx.coupon.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'cpn-1',
        OR: [{ maxRedemptions: null }, { redemptions: { lt: 'Coupon.maxRedemptions' } }],
      },
      data: { redemptions: { increment: 1 } },
    });
  });

  /*
    Parallel checkouts on one coupon took a 100-use coupon past 100: the limit was checked when
    each booking was created and the count bumped unconditionally when each was paid.
  */
  it('still confirms a paid booking whose coupon ran out meanwhile, and audits it', async () => {
    const { service, tx, audit } = setup({
      booking: pendingBooking({ couponId: 'cpn-1' }),
      claimCount: 1,
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });
    tx.coupon.updateMany.mockResolvedValue({ count: 0 }); // already at maxRedemptions
    await expect(service.handleWebhook(webhook)).resolves.toMatchObject({ status: 'confirmed' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_REDEEMED_OVER_LIMIT',
        entityType: 'Coupon',
        entityId: 'cpn-1',
      }),
    );
  });

  it('is idempotent: a concurrent re-delivery (claim count 0) issues no tickets', async () => {
    const { service, tx, eventPublisher } = setup({
      booking: pendingBooking(),
      claimCount: 0, // another delivery already flipped it
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });

    const result = await service.handleWebhook(webhook);

    expect(result).toEqual({ status: 'already_confirmed', bookingId: 'b1' });
    expect(tx.ticket.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
    // No real confirm happened → no outbox record + no delivery (recorded/delivered once).
    expect(eventPublisher.recordInTransaction).not.toHaveBeenCalled();
    expect(eventPublisher.deliverAfterCommit).not.toHaveBeenCalled();
  });

  it('returns already_confirmed for a pre-claim CONFIRMED booking without opening a tx', async () => {
    const { service, prisma } = setup({
      booking: pendingBooking({ status: BookingStatus.CONFIRMED }),
    });
    const result = await service.handleWebhook(webhook);
    expect(result).toEqual({ status: 'already_confirmed', bookingId: 'b1' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls back (throws) when the strategy settles fewer units than expected', async () => {
    const { service, tx } = setup({
      booking: pendingBooking(), // expects 2 units
      claimCount: 1,
      specs: [{ ticketTypeId: 't1' }], // only 1 settled → oversell/expiry guard
    });
    await expect(service.handleWebhook(webhook)).rejects.toBeInstanceOf(AppException);
    expect(tx.ticket.create).not.toHaveBeenCalled();
  });
});

/*
  The hold expired while the buyer was still at the gateway, and the capture arrived after. It
  threw BOOKING_NOT_PAYABLE, retried six times, dead-lettered — and nothing recorded that a
  customer's money had been taken.
*/
describe('PaymentsService.confirm — money captured that cannot be applied', () => {
  const expired = () =>
    ({ ...pendingBooking({ status: BookingStatus.EXPIRED }), currency: 'INR' }) as BookingShape;
  const unapplied = {
    ...APPLIED_PAYMENT,
    status: PaymentStatus.PROCESSING,
    providerRef: 'order_1',
    providerPaymentIntentId: null,
  };

  it('records a capture on an expired booking instead of throwing into a dead-letter loop', async () => {
    const { service, prisma, finance, audit } = setup({ booking: expired(), payment: unapplied });

    const result = await service.handleWebhook(webhook);

    expect(result).toEqual({ status: 'captured_on_unpayable_booking', bookingId: 'b1' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'pay-row-1',
        status: PaymentAttemptStatus.SUCCEEDED,
        providerRef: 'mock_pi_123',
      }),
    });
    const paymentWrite = prisma.payment.update.mock.calls[0][0].data;
    expect(paymentWrite).toMatchObject({
      providerStatus: 'captured',
      failureCode: 'CAPTURED_ON_UNPAYABLE_BOOKING',
    });
    // The status is left alone, so this money never counts towards a settlement or payout.
    expect(paymentWrite).not.toHaveProperty('status');
    expect(finance.fileDiscrepancy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAYMENT_MISSING_INTERNALLY',
        provider: 'razorpay',
        entityRef: 'mock_pi_123',
        amountMinor: 5000,
        currency: 'INR',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_CAPTURED_ON_UNPAYABLE_BOOKING' }),
    );
  });

  it('does not record the same capture again when the webhook is redelivered', async () => {
    const { service, prisma, finance } = setup({ booking: expired(), payment: unapplied });
    prisma.paymentAttempt.findFirst.mockResolvedValue({ id: 'att-1' });
    await expect(service.handleWebhook(webhook)).resolves.toMatchObject({
      status: 'captured_on_unpayable_booking',
    });
    expect(prisma.paymentAttempt.create).not.toHaveBeenCalled();
    expect(finance.fileDiscrepancy).not.toHaveBeenCalled();
  });

  it('keeps refusing for the mock gateway, where no money exists', async () => {
    const { service, finance } = setup({
      booking: expired(),
      payment: { ...unapplied, provider: 'mock' },
    });
    await expect(service.handleWebhook(webhook)).rejects.toMatchObject({
      code: ErrorCodes.BOOKING_NOT_PAYABLE,
    });
    expect(finance.fileDiscrepancy).not.toHaveBeenCalled();
  });

  it('files a second charge on an already-paid booking as a duplicate capture', async () => {
    const { service, prisma, finance } = setup({
      booking: pendingBooking({ status: BookingStatus.CONFIRMED, currency: 'INR' }),
      payment: {
        ...APPLIED_PAYMENT,
        providerRef: 'pay_first',
        providerPaymentIntentId: 'pay_first',
      },
    });
    const result = await service.handleWebhook(webhook);
    expect(result).toEqual({ status: 'already_confirmed', bookingId: 'b1' });
    expect(finance.fileDiscrepancy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DUPLICATE_CAPTURE', entityRef: 'mock_pi_123' }),
    );
    // The applied payment is left describing the capture that was applied.
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('treats a redelivery of the capture already applied as nothing new', async () => {
    const { service, finance, prisma } = setup({
      booking: pendingBooking({ status: BookingStatus.CONFIRMED, currency: 'INR' }),
    });
    await service.handleWebhook(webhook);
    expect(finance.fileDiscrepancy).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.create).not.toHaveBeenCalled();
  });
});

/*
  A hold outlives a cancellation, and createIntent never looked at the show — so a cancelled
  show could still open a gateway order and take payment.
*/
describe('PaymentsService.createIntent — the show must still be on', () => {
  const OWNER = { id: 'u1', email: 'u1@example.test', fullName: 'Ada', roles: [] } as never;
  const future = new Date(Date.now() + 86_400_000);
  const payable = (eventSession: { status: string; startsAt: Date }) =>
    ({
      ...pendingBooking({ currency: 'INR' }),
      subtotalMinor: 5000,
      organizerFeeMinor: 0,
      discountMinor: 0,
      payment: { id: 'pay-row-1' },
      event: { organizationId: 'org-1', isFree: false, venue: { country: 'IN' } },
      eventSession,
    }) as unknown as BookingShape;

  it.each([
    ['cancelled', { status: 'CANCELLED', startsAt: future }],
    ['paused', { status: 'PAUSED', startsAt: future }],
    ['already started', { status: 'SCHEDULED', startsAt: new Date(Date.now() - 60_000) }],
  ])('refuses to take payment for a show that is %s', async (_label, session) => {
    const { service, orchestrator, razorpayOrders } = setup({ booking: payable(session) });
    await expect(service.createIntent('b1', OWNER)).rejects.toMatchObject({
      code: ErrorCodes.BOOKING_NOT_PAYABLE,
    });
    expect(orchestrator.createPayment).not.toHaveBeenCalled();
    expect(razorpayOrders.createOrder).not.toHaveBeenCalled();
  });

  it('still opens a payment for a scheduled show that has not started', async () => {
    const { service, orchestrator, razorpayOrders } = setup({
      booking: payable({ status: 'SCHEDULED', startsAt: future }),
    });
    await service.createIntent('b1', OWNER);
    expect(
      orchestrator.createPayment.mock.calls.length + razorpayOrders.createOrder.mock.calls.length,
    ).toBe(1);
  });

  /*
    The ownership check ran only when a user was passed, and the guest pay route passes none —
    so a signed-in customer's booking could be paid through the guest path by anybody with its id.
  */
  it('refuses a booking that belongs to an account when no account is paying', async () => {
    const { service, orchestrator, razorpayOrders } = setup({
      booking: payable({ status: 'SCHEDULED', startsAt: future }),
    });
    await expect(service.createIntent('b1')).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
    expect(orchestrator.createPayment).not.toHaveBeenCalled();
    expect(razorpayOrders.createOrder).not.toHaveBeenCalled();
  });

  it('still lets a guest booking be paid with no account', async () => {
    const guest = {
      ...(payable({ status: 'SCHEDULED', startsAt: future }) as object),
      userId: null,
    } as unknown as BookingShape;
    const { service, orchestrator, razorpayOrders } = setup({ booking: guest });
    await service.createIntent('b1');
    expect(
      orchestrator.createPayment.mock.calls.length + razorpayOrders.createOrder.mock.calls.length,
    ).toBe(1);
  });
});

/*
  A show cancelled after the buyer opened the gateway but before the capture arrived still
  confirmed, and issued tickets to a show that is not happening.
*/
describe('PaymentsService.confirm — the show must still be on when the money lands', () => {
  const onCancelledShow = () =>
    ({
      ...pendingBooking({ currency: 'INR' }),
      eventSession: { status: 'CANCELLED', startsAt: new Date(), screen: null },
    }) as unknown as BookingShape;

  it('records the capture for a manual refund and issues no tickets', async () => {
    const { service, prisma, finance } = setup({
      booking: onCancelledShow(),
      payment: { ...APPLIED_PAYMENT, status: PaymentStatus.PROCESSING, providerRef: 'order_1' },
    });
    await expect(service.handleWebhook(webhook)).resolves.toEqual({
      status: 'captured_on_unpayable_booking',
      bookingId: 'b1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(finance.fileDiscrepancy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAYMENT_MISSING_INTERNALLY',
        detail: expect.stringContaining('CANCELLED'),
      }),
    );
  });

  it('refuses to take cash at the counter for it', async () => {
    const booking = {
      ...(onCancelledShow() as object),
      paymentMethod: 'CASH',
      cashCollectedAt: null,
    } as unknown as BookingShape;
    const { service, prisma } = setup({ booking });
    await expect(service.collectCash('b1', 'staff-1')).rejects.toMatchObject({
      code: ErrorCodes.BOOKING_NOT_PAYABLE,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/*
  Cash was stamped as collected BEFORE confirming. When confirming then failed, every retry
  answered "already collected" and the tickets for money handed over were never issued.
*/
describe('PaymentsService.collectCash — the stamp and the confirmation are one fact', () => {
  const cashBooking = () =>
    ({
      ...pendingBooking({ currency: 'INR' }),
      paymentMethod: 'CASH',
      cashCollectedAt: null,
    }) as unknown as BookingShape;

  it('stamps who collected the cash in the same update that confirms the booking', async () => {
    const { service, prisma, tx } = setup({
      booking: cashBooking(),
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });
    await expect(service.collectCash('b1', 'staff-1')).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: BookingStatus.PENDING_PAYMENT },
      data: expect.objectContaining({
        status: BookingStatus.CONFIRMED,
        cashCollectedAt: expect.any(Date),
        cashCollectedByUserId: 'staff-1',
      }),
    });
  });

  it('leaves no stamp behind when confirming fails, so the collection can be retried', async () => {
    const { service, prisma } = setup({
      booking: cashBooking(),
      specs: [{ ticketTypeId: 't1' }], // one of two units — the confirmation rolls back
    });
    await expect(service.collectCash('b1', 'staff-1')).rejects.toBeInstanceOf(AppException);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('answers already_collected to the second of two simultaneous collections', async () => {
    const { service, audit } = setup({ booking: cashBooking(), claimCount: 0 });
    await expect(service.collectCash('b1', 'staff-2')).resolves.toEqual({
      status: 'already_collected',
      bookingId: 'b1',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
