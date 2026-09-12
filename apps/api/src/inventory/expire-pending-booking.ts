import type { Prisma } from '@prisma/client';
import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import type { AddOnInventoryService } from '../commerce/addon-inventory.service';
import type { InventoryService } from './inventory.service';

/** The parts of an unpaid booking needed to give its stock back. */
export interface PendingBookingToExpire {
  id: string;
  eventSessionId: string;
  holdExpiresAt: Date;
  /** Settled when the booking was created; the release must use the strategy the hold used. */
  seatBased: boolean;
  items: { ticketTypeId: string | null; addOnId: string | null; quantity: number }[];
}

type ReleaseDeps = { inventory: InventoryService; addOnInventory: AddOnInventoryService };

/**
 * Expire one unpaid booking and return what it held — exactly once.
 *
 * ── WHY THE STATUS CHANGE COMES FIRST, AND IS CONDITIONAL ─────────────────────────────
 * This used to read the stale bookings OUTSIDE the transaction and then, inside it, release
 * the stock and write EXPIRED by id with no check on what the booking had become meanwhile.
 * Two sweeps run concurrently as a matter of course — the worker every minute, and every
 * `create()` on every replica — so both could release the same hold, decrementing
 * `quantityHeld` twice and letting the counter sell stock that was still held by somebody
 * else. Worse, a booking CONFIRMED by a late webhook between the read and the release was
 * overwritten to EXPIRED with its seats handed back: paid tickets for resold seats.
 *
 * The claim is now the first statement: a single conditional UPDATE that only matches a
 * booking still awaiting payment (and, for a sweep, still lapsed). Postgres serialises the
 * row, so a concurrent sweep or confirmation that got there first leaves this one matching
 * nothing, and nothing else here runs. Only the transaction that actually moved the booking
 * releases its stock.
 *
 * `lapsedBefore` is omitted when the booking is being expired for a reason other than its
 * timer — a cancelled show — and given when it is a sweep, so a hold extended after the
 * sweep read it is left alone.
 *
 * Returns whether this call expired the booking.
 */
export async function expirePendingBooking(
  tx: Prisma.TransactionClient,
  booking: PendingBookingToExpire,
  deps: ReleaseDeps,
  lapsedBefore?: Date,
): Promise<boolean> {
  return releasePendingBooking(tx, booking, deps, BookingStatus.EXPIRED, lapsedBefore);
}

/**
 * Cancel one unpaid booking at its buyer's request and return what it held — exactly once.
 *
 * The same claim-first release as expiry, ending CANCELLED rather than EXPIRED so the buyer's
 * history says they let it go rather than that it ran out. There is no `lapsedBefore`: the
 * buyer may cancel at any point while the booking still awaits payment, and a double-click, a
 * sweep or a confirmation that got there first leaves this call claiming nothing.
 *
 * Returns whether this call cancelled the booking.
 */
export async function cancelPendingBooking(
  tx: Prisma.TransactionClient,
  booking: PendingBookingToExpire,
  deps: ReleaseDeps,
): Promise<boolean> {
  return releasePendingBooking(tx, booking, deps, BookingStatus.CANCELLED);
}

async function releasePendingBooking(
  tx: Prisma.TransactionClient,
  booking: PendingBookingToExpire,
  deps: ReleaseDeps,
  outcome: typeof BookingStatus.EXPIRED | typeof BookingStatus.CANCELLED,
  lapsedBefore?: Date,
): Promise<boolean> {
  const claimed = await tx.booking.updateMany({
    where: {
      id: booking.id,
      status: BookingStatus.PENDING_PAYMENT,
      ...(lapsedBefore ? { holdExpiresAt: { lt: lapsedBefore } } : {}),
    },
    data: { status: outcome, cancelledAt: new Date() },
  });
  if (claimed.count !== 1) return false;

  /*
    The strategy follows the booking's own `seatBased`, the same one confirmation and refund
    use. Choosing it by experience type meant a seated concert's abandoned checkout was
    released as general admission: the counters moved and the ShowSeat rows stayed HELD
    against a dead booking for ever.
  */
  const strategy = deps.inventory.forSeating(booking.seatBased);
  // Ticket holds (direct + bundle ticket components) vs add-on holds (v1.3).
  const ticketLines = booking.items
    .filter((i) => i.ticketTypeId)
    .map((i) => ({ ticketTypeId: i.ticketTypeId as string, quantity: i.quantity }));
  const addOnLines = booking.items
    .filter((i) => i.addOnId)
    .map((i) => ({ addOnId: i.addOnId as string, quantity: i.quantity }));

  if (ticketLines.length > 0) {
    await strategy.release(tx, {
      eventSessionId: booking.eventSessionId,
      bookingId: booking.id,
      holdExpiresAt: booking.holdExpiresAt,
      lines: ticketLines,
    });
  }
  if (addOnLines.length > 0) {
    await deps.addOnInventory.release(tx, addOnLines);
  }
  await tx.payment.updateMany({
    where: { bookingId: booking.id, status: PaymentStatus.REQUIRES_PAYMENT },
    data: { status: PaymentStatus.FAILED },
  });
  return true;
}
