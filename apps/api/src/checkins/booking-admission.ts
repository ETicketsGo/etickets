import { BookingStatus } from '@eticketsgo/shared-types';

/**
 * Whether a ticket's BOOKING still entitles anyone to enter.
 *
 * ── WHY THE GATE MUST LOOK AT THE BOOKING, NOT ONLY THE TICKET ─────────────────────
 * Several reversals change the booking (or its payment) without touching the ticket rows: a
 * refund made in the provider's dashboard, the automatic compensation refund, an expired or
 * cancelled hold. The QR code never expires and is not rotated by a refund, so a gate that
 * checks only `ticket.status` admits whoever kept the screenshot of a refunded booking.
 *
 * Admits CONFIRMED and PARTIALLY_REFUNDED (its remaining tickets are still paid for).
 * DISPUTED is admitted deliberately for now — a chargeback in progress is not yet lost, and
 * event-attendees.query.ts treats disputed attendees as present; refusing it is a policy
 * decision, not a bug fix.
 */
const NOT_ADMITTING: readonly string[] = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.CANCELLED,
  BookingStatus.EXPIRED,
  BookingStatus.REFUNDED,
];

export function bookingAdmits(status: string | null | undefined): boolean {
  return typeof status === 'string' && !NOT_ADMITTING.includes(status);
}
