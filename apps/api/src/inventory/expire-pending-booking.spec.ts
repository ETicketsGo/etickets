import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import { cancelPendingBooking, expirePendingBooking } from './expire-pending-booking';

/**
 * Giving an unpaid booking's stock back, exactly once.
 *
 * The expiry sweep and the buyer's own cancellation share one release. What these pin is the
 * order that makes it safe: the conditional status change runs first, and a caller that did not
 * win it releases nothing — so a double-click, or a sweep racing a cancellation, can never hand
 * the same seats back twice.
 */
function setup(claimCount = 1) {
  const calls: string[] = [];
  const tx = {
    booking: {
      updateMany: jest.fn(async () => {
        calls.push('claim');
        return { count: claimCount };
      }),
    },
    payment: {
      updateMany: jest.fn(async () => {
        calls.push('payment');
        return { count: 1 };
      }),
    },
  };
  const strategy = {
    release: jest.fn(async () => {
      calls.push('release');
    }),
  };
  const deps = {
    inventory: { forSeating: jest.fn().mockReturnValue(strategy) },
    addOnInventory: {
      release: jest.fn(async () => {
        calls.push('addOnRelease');
      }),
    },
  };
  const booking = {
    id: 'bk-1',
    eventSessionId: 'sess-1',
    holdExpiresAt: new Date('2026-09-12T10:00:00Z'),
    seatBased: true,
    items: [
      { ticketTypeId: 'tt-1', addOnId: null, quantity: 2 },
      { ticketTypeId: null, addOnId: 'ao-1', quantity: 1 },
    ],
  };
  return { tx, strategy, deps, booking, calls };
}

describe('expirePendingBooking', () => {
  it('claims a lapsed booking as EXPIRED before releasing anything', async () => {
    const { tx, deps, booking, calls } = setup();
    const lapsedBefore = new Date('2026-09-12T10:05:00Z');
    await expect(
      expirePendingBooking(tx as never, booking, deps as never, lapsedBefore),
    ).resolves.toBe(true);
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'bk-1',
        status: BookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { lt: lapsedBefore },
      },
      data: expect.objectContaining({ status: BookingStatus.EXPIRED }),
    });
    expect(calls).toEqual(['claim', 'release', 'addOnRelease', 'payment']);
  });
});

describe('cancelPendingBooking', () => {
  it('claims the booking as CANCELLED whatever its timer says, then releases its stock', async () => {
    const { tx, strategy, deps, booking, calls } = setup();
    await expect(cancelPendingBooking(tx as never, booking, deps as never)).resolves.toBe(true);
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'bk-1', status: BookingStatus.PENDING_PAYMENT },
      data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
    });
    expect(deps.inventory.forSeating).toHaveBeenCalledWith(true);
    expect(strategy.release).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        bookingId: 'bk-1',
        lines: [{ ticketTypeId: 'tt-1', quantity: 2 }],
      }),
    );
    // Only an unopened payment is failed; one already at the gateway is left for its webhook.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { bookingId: 'bk-1', status: PaymentStatus.REQUIRES_PAYMENT },
      data: { status: PaymentStatus.FAILED },
    });
    expect(calls).toEqual(['claim', 'release', 'addOnRelease', 'payment']);
  });

  it('releases nothing when another caller moved the booking first', async () => {
    const { tx, deps, booking, calls } = setup(0);
    await expect(cancelPendingBooking(tx as never, booking, deps as never)).resolves.toBe(false);
    expect(calls).toEqual(['claim']);
  });
});
