/**
 * Where a buyer goes once a booking exists.
 *
 * A free event's booking comes back CONFIRMED: the API skipped the payment provider entirely,
 * because there is nothing to collect and a gateway asked to charge zero is a support ticket
 * waiting to happen. Sending that buyer to the payment screen would show them a bill for
 * nothing and a pay button that can only fail — the booking is already paid for, in the sense
 * that it never owed anything.
 *
 * Decided from the status the SERVER returned, not from a local guess about whether the event
 * looked free. The server is the only party that knows whether money was actually skipped.
 */
export function nextStepAfterBooking(booking: { id: string; status?: string }): string {
  return booking.status === 'CONFIRMED'
    ? `/booking/${booking.id}/confirmation`
    : `/booking/${booking.id}/payment`;
}
