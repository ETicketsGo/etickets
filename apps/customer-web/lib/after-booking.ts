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
export function nextStepAfterBooking(booking: {
  id: string;
  status?: string;
  paymentMethod?: 'ONLINE' | 'CASH';
}): string {
  if (booking.status === 'CONFIRMED') return `/booking/${booking.id}/confirmation`;
  /*
    A cash booking is reserved, not paid, and has no Payment row — so the payment screen
    would show a bill with no way to settle it and a button that cannot work. It gets its own
    page, which says what was held and what to bring.
  */
  if (booking.paymentMethod === 'CASH') return `/booking/${booking.id}/reserved`;
  return `/booking/${booking.id}/payment`;
}
