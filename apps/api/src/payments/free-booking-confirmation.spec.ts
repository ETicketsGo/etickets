import { BookingStatus, ExperienceType } from '@eticketsgo/shared-types';
import { PaymentsService } from './payments.service';
import { MetricsService } from '../metrics/metrics.service';
import { BookingReferenceService } from '../bookings/booking-reference.service';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';

/**
 * Confirming a booking that cost nothing, without a payment provider anywhere near it.
 *
 * `confirmFreeBooking` is the free equivalent of a verified webhook: it runs the same
 * confirmation the paid path runs — claim the booking, mint the tickets and their QR codes,
 * settle inventory, notify the customer — and skips only the two writes that describe money
 * changing hands.
 *
 * ── THE GUARD THAT MATTERS ─────────────────────────────────────────────────────────
 * This method issues tickets with NO payment. If it could be persuaded to run against a
 * priced booking, it would be a way to obtain paid tickets for nothing. So it re-reads the
 * total from the database and refuses anything but zero — it never trusts an amount handed
 * to it, because the whole point is that no amount was handed to it.
 */
interface Over {
  totalMinor?: number;
  status?: string;
  missing?: boolean;
}

function setup(over: Over = {}) {
  const booking = over.missing
    ? null
    : {
        id: 'bk-1',
        status: over.status ?? BookingStatus.PENDING_PAYMENT,
        eventSessionId: 'sess-1',
        organizationId: 'org-1',
        buyerName: 'F',
        buyerEmail: 'free@t.test',
        userId: 'u-1',
        holdExpiresAt: new Date(Date.now() + 900_000),
        couponId: null,
        totalMinor: over.totalMinor ?? 0,
        items: [{ ticketTypeId: 'tt-1', quantity: 2 }],
        event: {
          experienceType: ExperienceType.EVENT,
          isFree: true,
          organizationId: 'org-1',
          venue: { country: 'India' },
        },
        eventSession: {
          startsAt: new Date(Date.now() + 7 * 86_400_000),
          screen: null,
        },
      };

  const tx = {
    booking: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    bookingReferenceCounter: {
      upsert: jest.fn().mockResolvedValue({ scope: 'IND-2026', value: 7 }),
    },
    ticket: { create: jest.fn().mockResolvedValue({}) },
    payment: { update: jest.fn().mockResolvedValue({}) },
    paymentAttempt: { create: jest.fn().mockResolvedValue({}) },
    coupon: { update: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const strategy = {
    confirm: jest.fn().mockResolvedValue([{ ticketTypeId: 'tt-1' }, { ticketTypeId: 'tt-1' }]),
  };
  const orchestrator = {
    createPayment: jest.fn().mockResolvedValue({ intent: {}, provider: 'mock' }),
    refund: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const razorpayOrders = { createOrder: jest.fn(), verify: jest.fn() };

  const service = new PaymentsService(
    prisma as never,
    { verifyWebhook: jest.fn() } as never,
    { signEvent: jest.fn() } as never,
    orchestrator as never,
    /*
      The resolver. The marketplace gate used to ask the GLOBALLY configured provider
      whether it supported transfers — which is the mock — so the gate refusing a paid
      booking from an organizer with no charges-enabled account was skipped entirely, and a
      USD charge would have gone to Stripe with nothing tying it to an organizer. It now
      asks the provider that will actually take the money.
    */
    // A free booking never reaches a provider at all, so the resolver is never asked —
    // throwing here proves that rather than assuming it.
    {
      get: jest.fn(() => {
        throw new Error('a free booking must not resolve a payment provider');
      }),
    } as never,
    audit as never,
    notifications as never,
    { forSeating: jest.fn().mockReturnValue(strategy) } as never,
    new AddOnInventoryService(),
    new MetricsService(),
    new BookingReferenceService(),
    { issueForBooking: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn().mockReturnValue('LOCAL') } as never,
    { onPaymentSucceeded: jest.fn().mockResolvedValue(undefined) } as never,
    razorpayOrders as never,
    {
      recordInTransaction: jest.fn().mockResolvedValue(0),
      deliverAfterCommit: jest.fn().mockResolvedValue(undefined),
    } as never,
    { onConfirmed: async () => undefined, preConfirm: async () => ({ handled: false }) } as never,
  );

  return { service, prisma, tx, strategy, audit, orchestrator, razorpayOrders, notifications };
}

describe('PaymentsService.confirmFreeBooking', () => {
  it('issues the tickets, exactly as a paid confirmation would', async () => {
    // "The remaining functionality should work as expected like sending the tickets and QR
    // codes" — so the free path runs the real confirmation, not a reduced imitation of it.
    const { service, tx, strategy, notifications } = setup();
    const result = await service.confirmFreeBooking('bk-1');

    expect(result).toMatchObject({ status: 'confirmed', bookingId: 'bk-1', tickets: 2 });
    expect(strategy.confirm).toHaveBeenCalled();
    expect(tx.ticket.create).toHaveBeenCalledTimes(2);
    expect(notifications.send).toHaveBeenCalled();
  });

  it('writes no payment and no payment attempt', async () => {
    /*
      The two writes that describe money moving. A free booking has no Payment row to update
      — `where: { bookingId }` would throw on the missing row — and a SUCCEEDED attempt for
      ₹0 would sit in the reconciliation reports for ever, unmatchable against any statement.
    */
    const { service, tx } = setup();
    await service.confirmFreeBooking('bk-1');

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
    // The booking itself is still claimed and confirmed.
    expect(tx.booking.updateMany).toHaveBeenCalled();
  });

  it('refuses a booking that actually owes money, and says so in the audit log', async () => {
    /*
      The security guarantee. Reached with a booking id alone and no amount, this is the one
      place where tickets are minted with nothing paid — so it re-reads the total from the
      database rather than believing any caller.
    */
    const { service, tx, audit } = setup({ totalMinor: 50_000 });

    await expect(service.confirmFreeBooking('bk-1')).rejects.toThrow(
      /has an amount to pay and cannot be confirmed as free/i,
    );
    expect(tx.ticket.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FREE_CONFIRM_REFUSED' }),
    );
  });

  it('is idempotent — a second call does not mint a second set of tickets', async () => {
    const { service, tx } = setup({ status: BookingStatus.CONFIRMED });
    const result = await service.confirmFreeBooking('bk-1');

    expect(result).toMatchObject({ status: 'already_confirmed' });
    expect(tx.ticket.create).not.toHaveBeenCalled();
  });

  it('does not invent a booking that is not there', async () => {
    const { service } = setup({ missing: true });
    await expect(service.confirmFreeBooking('nope')).rejects.toThrow(/Booking not found/i);
  });
});

describe('PaymentsService.createIntent on a free event', () => {
  it('refuses outright rather than opening a zero-amount order at a gateway', async () => {
    /*
      "Free event should not even call payments api." In practice a free booking is CONFIRMED
      before anything could reach here — but if confirmation failed and left the hold pending,
      the old code would have fallen straight through to provider routing and asked Razorpay
      to collect ₹0. This is the backstop, and it is asserted at the provider boundary: no
      order created, by any route.
    */
    const { service, orchestrator, razorpayOrders } = setup();
    // createIntent reads its own shape of booking; the free event flag is what it turns on.
    const prisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'bk-1',
          userId: null,
          status: BookingStatus.PENDING_PAYMENT,
          holdExpiresAt: new Date(Date.now() + 900_000),
          subtotalMinor: 0,
          organizerFeeMinor: 0,
          discountMinor: 0,
          totalMinor: 0,
          currency: 'INR',
          eventId: 'ev-1',
          payment: null,
          event: { organizationId: 'org-1', isFree: true, venue: { country: 'India' } },
        }),
      },
    };
    (service as unknown as { prisma: unknown }).prisma = prisma;

    await expect(service.createIntent('bk-1')).rejects.toThrow(/This event is free/i);
    expect(orchestrator.createPayment).not.toHaveBeenCalled();
    expect(razorpayOrders.createOrder).not.toHaveBeenCalled();
  });
});
