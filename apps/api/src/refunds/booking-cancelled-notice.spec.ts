import { BookingStatus, NotificationType, TicketStatus } from '@eticketsgo/shared-types';
import { RefundsService } from './refunds.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Who is told when a booking ends, and by which message.
 *
 * BOOKING_CANCELLED had a template in both languages and no producer: a buyer who cancelled
 * their booking heard nothing. A booking ends CANCELLED in these places:
 *
 *   - the buyer, signed in, gives back a free booking          -> BOOKING_CANCELLED
 *   - a guest gives back a free booking through the access link -> BOOKING_CANCELLED
 *   - the show is cancelled and the free booking goes with it   -> SHOW_CANCELLED, once
 *   - a cash booking on a cancelled show (CashReturnsService)   -> SHOW_CANCELLED, by the fan-out
 *   - an unpaid hold cancelled, released or expired             -> nothing (no money, no ticket,
 *                                                                  no reference; see BookingsService)
 *
 * A paid booking that is given back does not end CANCELLED: it is REFUNDED, and its buyer hears
 * REFUND_REQUESTED / REFUND_COMPLETED. So this suite asserts it gets no BOOKING_CANCELLED.
 */
function setup(opts: { userId?: string | null; totalMinor?: number; remaining?: number } = {}) {
  const userId = opts.userId === undefined ? 'u1' : opts.userId;
  const tickets = ['tk1', 'tk2'].slice(0, opts.remaining ? 2 : 1).map((id, i) => ({
    id,
    status: TicketStatus.ACTIVE,
    ticketTypeId: 't1',
    seatId: `seat-${i + 1}`,
    invites: [],
  }));
  const booking = {
    id: 'b1',
    userId,
    buyerEmail: 'buyer@t.test',
    reference: 'ETG-IND-2026-000042',
    organizationId: 'org-1',
    status: BookingStatus.CONFIRMED,
    paymentMethod: 'ONLINE',
    currency: 'INR',
    totalMinor: opts.totalMinor ?? 0,
    subtotalMinor: opts.totalMinor ?? 0,
    discountMinor: 0,
    eventSessionId: 'sess-1',
    seatBased: true,
    eventSession: { startsAt: new Date('2026-12-01T14:30:00.000Z') },
    event: { refundsEnabled: true, refundCutoffHours: 48 },
    tickets,
    taxLines: [],
  };
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
      updateMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({
        count: where.id.in.length,
      })),
      count: jest.fn().mockResolvedValue(opts.remaining ?? 0),
    },
    // What the cancelling update reads back for the message.
    booking: {
      update: jest.fn().mockResolvedValue({
        userId,
        buyerEmail: 'buyer@t.test',
        reference: 'ETG-IND-2026-000042',
        event: { title: 'Walk Show', venue: { timezone: 'Asia/Kolkata', country: 'India' } },
        eventSession: { startsAt: new Date('2026-12-01T14:30:00.000Z'), screen: null },
      }),
    },
  };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    bookingItem: {
      findMany: jest.fn().mockResolvedValue([
        {
          ticketTypeId: 't1',
          unitPriceMinor: opts.totalMinor ?? 0,
          quantity: tickets.length,
        },
      ]),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { send: jest.fn(), sendCritical: jest.fn().mockResolvedValue(undefined) };
  const service = new RefundsService(
    prisma as never,
    { refundPayment: jest.fn() } as never,
    { forSeating: jest.fn().mockReturnValue({ refund: jest.fn() }) } as never,
    { isPlatformAdmin: () => false, assertMember: async () => undefined } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    notifications as never,
    new MetricsService(),
    { issueCreditNote: jest.fn() } as never,
  );
  /** Every notification written, by type, with the transaction it was written in. */
  const sent = (type: string) =>
    notifications.sendCritical.mock.calls.filter((c) => c[1].type === type);
  return { service, tx, sent, notifications };
}

const BUYER = { id: 'u1', email: 'buyer@t.test', fullName: 'B', roles: [] } as never;
const CANCEL = { bookingId: 'b1', reason: 'cannot make it' };

describe('a buyer ending their own free booking', () => {
  it('is sent exactly one BOOKING_CANCELLED, in the cancelling transaction', async () => {
    const { service, tx, sent } = setup();
    await service.request(BUYER, CANCEL);

    const told = sent(NotificationType.BOOKING_CANCELLED);
    expect(told).toHaveLength(1);
    expect(told[0][0]).toBe(tx);
    expect(told[0][1]).toMatchObject({
      userId: 'u1',
      toEmail: 'buyer@t.test',
      bookingId: 'b1',
      payload: {
        bookingId: 'b1',
        reference: 'ETG-IND-2026-000042',
        eventTitle: 'Walk Show',
        startsAt: '2026-12-01T14:30:00.000Z',
        timeZone: 'Asia/Kolkata',
        refundStatus: 'NOTHING_TO_REFUND',
      },
    });
    expect(sent(NotificationType.SHOW_CANCELLED)).toHaveLength(0);
  });

  it('is told nothing when one ticket of two is given back and the booking lives on', async () => {
    const { service, notifications } = setup({ remaining: 1 });
    await service.request(BUYER, { ...CANCEL, ticketIds: ['tk1'] });
    expect(notifications.sendCritical).not.toHaveBeenCalled();
  });
});

describe('a guest ending their free booking through the access link', () => {
  it('is sent one BOOKING_CANCELLED at the address they paid with', async () => {
    const { service, sent } = setup({ userId: null });
    await service.requestAsGuest(CANCEL);

    const told = sent(NotificationType.BOOKING_CANCELLED);
    expect(told).toHaveLength(1);
    expect(told[0][1]).toMatchObject({ userId: null, toEmail: 'buyer@t.test' });
  });
});

describe('a free booking ended by a cancelled show', () => {
  it('is told once, by SHOW_CANCELLED, and never by BOOKING_CANCELLED', async () => {
    const { service, tx, sent } = setup();
    await service.openForCancelledSession('b1', 'The organiser cancelled this show.');

    expect(sent(NotificationType.BOOKING_CANCELLED)).toHaveLength(0);
    const shown = sent(NotificationType.SHOW_CANCELLED);
    expect(shown).toHaveLength(1);
    expect(shown[0][0]).toBe(tx);
    expect(shown[0][1].payload).toMatchObject({
      bookingId: 'b1',
      eventTitle: 'Walk Show',
      refundStatus: 'NOTHING_TO_REFUND',
    });
  });
});

describe('a paid booking given back', () => {
  it('is a refund request, not a cancellation notice', async () => {
    const { service, notifications } = setup({ totalMinor: 50_000 });
    await service.request(BUYER, CANCEL);
    const types = notifications.sendCritical.mock.calls.map((c) => c[1].type);
    expect(types).not.toContain(NotificationType.BOOKING_CANCELLED);
  });
});
