/**
 * What a buyer with no account is shown of their own booking.
 *
 * ── WHY THIS IS NOT THE ACCOUNT BOOKING SHAPE ──────────────────────────────────────
 * The signed-in booking payload is a near-complete projection of the row: the buyer's email,
 * every fee column, the coupon, the payment, the pricing policy that priced it. It is safe
 * there because the reader proved who they are with a password.
 *
 * A guest proves nothing but possession of a token that arrived by email — forwardable, and
 * sitting in an inbox for years. So this is a deliberately SMALLER shape, enumerated field by
 * field rather than spread from the row, and adding to it is a decision somebody has to make
 * here rather than one that happens by including a relation. That is why the email is masked
 * and the fee columns collapse to four totals: a forwarded link shows somebody where to sit,
 * not who bought the seat or what card paid for it.
 */

/** Which show, where, and in whose clock. */
export interface GuestBookingEvent {
  title: string;
  slug: string;
  startsAt: string;
  /**
   * The zone the show actually starts in — the screen's cinema first, then the venue.
   *
   * Null rather than a guess when neither is known. A client can fall back visibly; it cannot
   * tell that a confidently returned zone was invented, which is how a ticket and its
   * confirmation email once disagreed by eleven and a half hours.
   */
  timeZone: string | null;
  venueName: string | null;
  cinemaName: string | null;
  screenName: string | null;
}

/**
 * Who bought it, as much as a link-holder may be told.
 *
 * `emailMasked` is never the full address. The link is forwardable and the person who opens
 * it may not be the buyer, so this is enough for the buyer to recognise their own booking and
 * not enough for anybody else to learn an address they did not already have.
 */
export interface GuestBookingBuyer {
  name: string;
  emailMasked: string;
}

/** The money, in integer minor units, exactly as the booking recorded it. */
export interface GuestBookingTotals {
  subtotalMinor: number;
  /** What the customer pays in fees, all in — not the platform's or the organizer's share. */
  feesMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** One line of the order as it was priced. */
export interface GuestBookingItem {
  label: string;
  quantity: number;
  unitPriceMinor: number;
  seatLabel: string | null;
}

/**
 * One ticket, with its gate credential only when there is one to give.
 *
 * `qrToken`/`qrDataUrl` are null unless the booking is CONFIRMED, and null as well for a
 * ticket that has been transferred away — the credential belongs to whoever holds it now,
 * not to whoever paid.
 */
export interface GuestBookingTicket {
  id: string;
  seatLabel: string | null;
  ticketTypeName: string | null;
  qrToken: string | null;
  qrDataUrl: string | null;
  checkedInAt: string | null;
}

export interface GuestBookingView {
  id: string;
  /** Null on a booking that has not been confirmed: a reference is assigned when it is paid. */
  reference: string | null;
  status: string;
  currency: string;
  holdExpiresAt: string | null;
  event: GuestBookingEvent;
  buyer: GuestBookingBuyer;
  totals: GuestBookingTotals;
  items: GuestBookingItem[];
  tickets: GuestBookingTicket[];
  /**
   * When the emailed link stops working, or null when the booking was opened with the
   * checkout session rather than a link.
   *
   * Sent so the page can say so before the reader finds out by being turned away.
   */
  accessExpiresAt: string | null;
}
