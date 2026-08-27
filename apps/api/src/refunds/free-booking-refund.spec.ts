import {
  BookingStatus,
  ExperienceType,
  RefundStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { RefundsService } from './refunds.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Cancelling a free ticket.
 *
 * "Even if it is a free event the remaining functionality should work as expected — sending
 * the tickets and QR codes, cancel options, everything." Cancellation is the half of that
 * which touches the money path, so it is the half that could quietly break.
 *
 * A free booking has no Payment row, deliberately: a zero-amount payment would sit in every
 * settlement report as a line that can never be matched against a bank statement. So the
 * cancellation has to do everything a cancellation does — void the tickets, hand the seats
 * back, record the refund, tell the customer — while skipping the one leg that has no
 * counterpart: asking a gateway to return nothing.
 *
 * ── THE GUARD IS DELIBERATELY NARROW ───────────────────────────────────────────────
 * Skipping the gateway needs BOTH no payment row AND a zero amount. A booking that owes a
 * real refund but has lost its payment row is a fault; marking it COMPLETED without paying
 * anybody would be the platform keeping a customer's money. That case still goes down the
 * old path and still fails loudly.
 */
const ADMIN = {
  id: 'admin-1',
  email: 'a@t.test',
  fullName: 'A',
  roles: ['ADMIN'],
} as never;

function setup(opts: { amountMinor: number; hasPayment: boolean }) {
  const refund = {
    id: 'rf-1',
    bookingId: 'b1',
    organizationId: 'org-1',
    amountMinor: opts.amountMinor,
    reason: 'changed my mind',
    status: RefundStatus.REQUESTED,
    ticketIds: ['tk1'],
  };
  const booking = {
    id: 'b1',
    userId: 'u1',
    buyerEmail: 'free@t.test',
    eventSessionId: 'sess-1',
    currency: 'INR',
    totalMinor: opts.amountMinor,
    tickets: [{ id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1', seatId: null }],
    items: [{ ticketTypeId: 't1', unitPriceMinor: opts.amountMinor }],
    event: { experienceType: ExperienceType.EVENT },
  };

  const tx = {
    ticket: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    booking: { update: jest.fn().mockResolvedValue({}) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    refund: { update: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    adminGrant: { findFirst: jest.fn().mockResolvedValue({ id: 'grant-1' }) },
    refund: {
      findUnique: jest.fn().mockResolvedValue(refund),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    // The absence of this row is what marks the booking as never having been paid for.
    payment: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.hasPayment ? { providerRef: 'pi_123', provider: 'mock' } : null),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const strategy = { refund: jest.fn().mockResolvedValue(undefined) };
  const payments = { refundPayment: jest.fn().mockResolvedValue({ providerRef: 'rf_abc' }) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };

  const service = new RefundsService(
    prisma as never,
    payments as never,
    { forSeating: jest.fn().mockReturnValue(strategy) } as never,
    {
      isPlatformAdmin: () => true,
      assertMember: async () => undefined,
      assertPlatformAdmin: async () => undefined,
    } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    notifications as never,
    new MetricsService(),
    {
      issueCreditNote: jest.fn().mockResolvedValue(undefined),
      issueForBooking: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, tx, strategy, payments, notifications };
}

describe('cancelling a free booking', () => {
  it('never asks a gateway to return nothing', async () => {
    const { service, payments } = setup({ amountMinor: 0, hasPayment: false });
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it('still voids the ticket, returns the stock and completes the refund', async () => {
    // Everything downstream of the money is unchanged — that is the whole promise.
    const { service, tx, strategy, notifications } = setup({ amountMinor: 0, hasPayment: false });
    await service.process(ADMIN, 'rf-1', 'APPROVE');

    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: TicketStatus.REFUNDED } }),
    );
    expect(strategy.refund).toHaveBeenCalled();
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: BookingStatus.REFUNDED } }),
    );
    expect(tx.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RefundStatus.COMPLETED }),
      }),
    );
    expect(notifications.send).toHaveBeenCalled();
  });
});

describe('the gateway skip does not leak into paid bookings', () => {
  it('still calls the provider for an ordinary paid refund', async () => {
    const { service, payments } = setup({ amountMinor: 50_000, hasPayment: true });
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(payments.refundPayment).toHaveBeenCalledWith(
      'pi_123',
      50_000,
      'changed my mind',
      'mock',
      'INR',
    );
  });

  it('does not silently complete a real refund whose payment row has gone missing', async () => {
    /*
      The dangerous near-miss. Money IS owed, so the gateway must still be asked — even
      though the row that says which gateway is absent. Failing here is correct; quietly
      marking it refunded would mean the customer never gets their money.
    */
    const { service, payments } = setup({ amountMinor: 50_000, hasPayment: false });
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(payments.refundPayment).toHaveBeenCalledWith(
      'mock',
      50_000,
      'changed my mind',
      undefined,
      'INR',
    );
  });
});
