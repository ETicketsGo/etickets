import {
  BookingStatus,
  ExperienceType,
  PaymentAttemptStatus,
  PaymentStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { PaymentsService } from './payments.service';
import { AppException } from '../common/errors';
import type { PaymentEvent } from './provider/payment-provider.interface';
import { MetricsService } from '../metrics/metrics.service';

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
  items: Array<{ ticketTypeId: string; quantity: number }>;
  event: { experienceType: string };
}

/** A tx mock exposing exactly the writes confirm() performs. */
function makeTx(claimCount: number) {
  return {
    booking: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }) },
    ticket: { create: jest.fn().mockResolvedValue({}) },
    payment: { update: jest.fn().mockResolvedValue({}) },
    paymentAttempt: { create: jest.fn().mockResolvedValue({}) },
    coupon: { update: jest.fn().mockResolvedValue({}) },
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
}) {
  const tx = makeTx(opts.claimCount ?? 1);
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(opts.booking) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const strategy = {
    confirm: jest.fn().mockResolvedValue(opts.specs ?? []),
  };
  const provider = { verifyWebhook: jest.fn().mockResolvedValue(SUCCEEDED_EVENT) };
  const mockProvider = {
    signEvent: jest.fn((e) => ({ rawBody: JSON.stringify(e), signature: 'x' })),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const inventory = { forExperienceType: jest.fn().mockReturnValue(strategy) };

  const service = new PaymentsService(
    prisma as never,
    provider as never,
    mockProvider as never,
    audit as never,
    notifications as never,
    inventory as never,
    new MetricsService(),
  );
  return { service, prisma, tx, strategy, provider, audit, notifications, inventory };
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
  items: [{ ticketTypeId: 't1', quantity: 2 }],
  event: { experienceType: ExperienceType.EVENT },
  ...over,
});

const webhook = { rawBody: '{}', signature: 'sig' };

describe('PaymentsService.confirm (via handleWebhook)', () => {
  it('confirms a pending booking: issues N tickets, marks SUCCEEDED, records attempt', async () => {
    const { service, tx, prisma, notifications, audit } = setup({
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
    expect(tx.coupon.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('increments the coupon redemption count when the booking used a coupon', async () => {
    const { service, tx } = setup({
      booking: pendingBooking({ couponId: 'cpn-1' }),
      claimCount: 1,
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });
    await service.handleWebhook(webhook);
    expect(tx.coupon.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cpn-1' },
        data: { redemptions: { increment: 1 } },
      }),
    );
  });

  it('is idempotent: a concurrent re-delivery (claim count 0) issues no tickets', async () => {
    const { service, tx } = setup({
      booking: pendingBooking(),
      claimCount: 0, // another delivery already flipped it
      specs: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }],
    });

    const result = await service.handleWebhook(webhook);

    expect(result).toEqual({ status: 'already_confirmed', bookingId: 'b1' });
    expect(tx.ticket.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
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
