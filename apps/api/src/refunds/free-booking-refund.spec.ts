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
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    // Critical notifications are written IN the domain transaction now, so the stub
    // captures the transaction client it was handed -- that IS the assertion.
    sendCritical: jest.fn().mockResolvedValue(undefined),
    fanOutCritical: jest.fn().mockResolvedValue(0),
  };

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
    expect(notifications.sendCritical).toHaveBeenCalled();
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

/*
  ── ASKING TO CANCEL A FREE BOOKING CANCELS IT ─────────────────────────────────────────
  A request on a free booking created a ₹0 refund, which sat in the organizer's and the
  platform's queues until somebody approved returning nothing — with the ticket still live and
  the seat still taken meanwhile. With no money to move there is nothing to decide, so the
  request now cancels the tickets there and then.
*/
describe('asking to cancel a free booking', () => {
  const BUYER = { id: 'u1', email: 'free@t.test', fullName: 'F', roles: [] } as never;
  const LIVE = [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN];

  function setupRequest(
    opts: {
      totalMinor?: number;
      claimCount?: number;
      remaining?: number;
      ticketIds?: string[];
    } = {},
  ) {
    const tickets = ['tk1', 'tk2'].slice(0, opts.remaining ? 2 : 1).map((id, i) => ({
      id,
      status: TicketStatus.ACTIVE,
      ticketTypeId: 't1',
      seatId: `seat-${i + 1}`,
      invites: [],
    }));
    const booking = {
      id: 'b1',
      userId: 'u1',
      organizationId: 'org-1',
      status: BookingStatus.CONFIRMED,
      paymentMethod: 'ONLINE',
      totalMinor: opts.totalMinor ?? 0,
      subtotalMinor: opts.totalMinor ?? 0,
      discountMinor: 0,
      eventSessionId: 'sess-1',
      seatBased: true,
      eventSession: { startsAt: new Date(Date.now() + 30 * 86_400_000) },
      event: { refundsEnabled: true, refundCutoffHours: 48 },
      tickets,
      taxLines: [],
    };
    const calls: string[] = [];
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      refund: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rf-new',
          ...data,
        })),
      },
      ticket: {
        updateMany: jest.fn(async () => {
          calls.push('claim');
          return { count: opts.claimCount ?? (opts.ticketIds?.length || tickets.length) };
        }),
        count: jest.fn().mockResolvedValue(opts.remaining ?? 0),
      },
      booking: { update: jest.fn().mockResolvedValue({}) },
    };
    const strategy = {
      refund: jest.fn(async () => {
        calls.push('release');
      }),
    };
    const inventory = { forSeating: jest.fn().mockReturnValue(strategy) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue(booking) },
      bookingItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ticketTypeId: 't1', unitPriceMinor: opts.totalMinor ?? 0, quantity: tickets.length },
          ]),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const service = new RefundsService(
      prisma as never,
      { refundPayment: jest.fn() } as never,
      inventory as never,
      { isPlatformAdmin: () => false, assertMember: async () => undefined } as never,
      audit as never,
      { send: jest.fn(), sendCritical: jest.fn() } as never,
      new MetricsService(),
      { issueCreditNote: jest.fn() } as never,
    );
    return { service, tx, strategy, inventory, audit, calls };
  }

  it('cancels the ticket at once and puts no ₹0 refund in anybody’s queue', async () => {
    const { service, tx, strategy, inventory, audit } = setupRequest();
    const res = await service.request(BUYER, { bookingId: 'b1', reason: 'cannot make it' });

    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(tx.ticket.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['tk1'] }, status: { in: LIVE } },
      data: { status: TicketStatus.CANCELLED },
    });
    // Back to the seat map it came from, by the booking's own seating.
    expect(inventory.forSeating).toHaveBeenCalledWith(true);
    expect(strategy.refund).toHaveBeenCalledWith(tx, {
      eventSessionId: 'sess-1',
      tickets: [{ ticketTypeId: 't1', seatId: 'seat-1' }],
    });
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FREE_TICKETS_CANCELLED', entityId: 'b1' }),
    );
    expect(res).toMatchObject({
      outcome: 'CANCELLED',
      bookingStatus: BookingStatus.CANCELLED,
      amountMinor: 0,
    });
  });

  it('keeps the booking confirmed while it still has live tickets', async () => {
    const { service, tx } = setupRequest({ remaining: 1, ticketIds: ['tk1'] });
    const res = await service.request(BUYER, {
      bookingId: 'b1',
      reason: 'one of us cannot come',
      ticketIds: ['tk1'],
    });
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['tk1'] }, status: { in: LIVE } } }),
    );
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ bookingStatus: BookingStatus.CONFIRMED });
  });

  it('returns no stock when another request cancelled the tickets first', async () => {
    // The claim changed nothing, so this call voided nothing and must release nothing.
    const { service, tx, strategy, calls } = setupRequest({ claimCount: 0 });
    await expect(
      service.request(BUYER, { bookingId: 'b1', reason: 'cannot make it' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(strategy.refund).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(calls).toEqual(['claim']);
  });

  it('still queues a refund for a booking that cost money', async () => {
    const { service, tx } = setupRequest({ totalMinor: 50_000 });
    await service.request(BUYER, { bookingId: 'b1', reason: 'cannot make it' });
    expect(tx.refund.create).toHaveBeenCalled();
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
  });
});
