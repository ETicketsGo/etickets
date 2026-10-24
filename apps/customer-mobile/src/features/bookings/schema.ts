import { z } from 'zod';
import { paginationMetaSchema } from '@/features/discovery/schema';

/**
 * Runtime contract for the customer's own bookings and tickets.
 *
 * Verified against the QA API on 2026-08-04. Unknown keys are allowed through by
 * default (Zod strips them), which is what we want: the API returns the full booking
 * row and will grow fields the app has no use for.
 */

/** Money on the wire is ALWAYS integer minor units. Never divide before formatting. */
const minor = z.number().int();

export const bookingSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventSessionId: z.string(),
  /** Human-facing ETG-<COUNTRY>-<YEAR>-<SEQ>. Null until the booking is confirmed. */
  reference: z.string().nullable(),
  buyerName: z.string(),
  buyerEmail: z.string(),
  status: z.string(),
  currency: z.string(),
  subtotalMinor: minor,
  bookingFeeMinor: minor,
  paymentFeeMinor: minor,
  discountMinor: minor,
  customerFeeMinor: minor,
  totalMinor: minor,
  /** When an unpaid hold lapses. The countdown on the checkout screen reads this. */
  holdExpiresAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  /** The venue's IANA zone. The session time is printed in it. */
  timeZone: z.string().nullish(),
  event: z.object({ title: z.string(), slug: z.string() }),
  eventSession: z.object({ startsAt: z.string() }),
  _count: z.object({ tickets: z.number() }),
});

/**
 * GET /bookings/:id. The list row's money and status, plus what only the detail carries:
 * the payment's own status and the issued tickets. Read directly rather than found in
 * page 1 of the list, which made any booking past the 50th "not found".
 */
export const bookingDetailSchema = bookingSchema.omit({ _count: true }).extend({
  event: z.object({
    title: z.string(),
    slug: z.string(),
    venue: z.object({ name: z.string().nullish(), city: z.string().nullish() }).nullish(),
    /** The event's own refund rule: whether it offers refunds, and until how long before. */
    refundsEnabled: z.boolean().nullish(),
    refundCutoffHours: z.number().nullish(),
    refundPolicy: z.string().nullish(),
  }),
  payment: z.object({ status: z.string(), provider: z.string().nullish() }).nullish(),
  tickets: z.array(z.object({ id: z.string() })).default([]),
});

export const bookingPageSchema = z.object({
  data: z.array(bookingSchema),
  meta: paginationMetaSchema,
});

export const ticketSchema = z.object({
  id: z.string(),
  serial: z.string(),
  status: z.string(),
  holderName: z.string().nullable(),
  ticketType: z.string(),
  event: z.object({ title: z.string(), slug: z.string() }),
  startsAt: z.string(),
  /**
   * The signed payload the scanner verifies. The app NEVER renders, logs, copies or
   * transmits this — it exists on the type only because it arrives in the response.
   * Display uses `qrDataUrl`, which the API renders server-side; generating a code from
   * this token client-side would mean inventing a QR encoding the scanner never agreed
   * to, and the first anyone would know is a queue that will not move.
   *
   * NULL when this viewer may see the ticket but not present it — e.g. the buyer of a
   * ticket they transferred to someone else (tickets.service.ts `mayPresent`). It was a
   * required string, so one transferred ticket failed the parse of the WHOLE wallet and
   * the customer saw no tickets at all. Missing and empty are treated the same as null.
   */
  qrToken: z.string().nullish(),
  /**
   * Server-rendered QR as a data: URI. This is what gets displayed and cached.
   *
   * NULL for a ticket whose barcode is a vendor code the server cannot draw as a QR. Not
   * optional-by-accident: a non-nullable string here failed the parse of the WHOLE wallet
   * array, so one such ticket emptied every ticket on the device. TicketQr already renders
   * its "code isn't available" state for it.
   */
  qrDataUrl: z.string().nullable(),
  bookingId: z.string(),
  bookingRef: z.string().nullable(),
  experienceType: z.string(),
  seatLabel: z.string().nullable(),
  venueName: z.string().nullable(),
  screenName: z.string().nullable(),
  cinemaName: z.string().nullable(),
  assignmentStatus: z.string(),
  attendeeName: z.string().nullable(),
  ownedByViewer: z.boolean(),
  assignedToViewer: z.boolean(),
});

export type Booking = z.infer<typeof bookingSchema>;
export type BookingDetail = z.infer<typeof bookingDetailSchema>;
export type Ticket = z.infer<typeof ticketSchema>;

/**
 * Booking states the API emits, grouped by what the customer should do about them.
 * Kept as a lookup rather than a union on the schema so an unrecognised status from a
 * newer API renders as itself instead of failing the whole list.
 */
export function bookingTone(status: string): 'success' | 'warning' | 'error' | 'neutral' {
  switch (status.toUpperCase()) {
    case 'CONFIRMED':
    case 'COMPLETED':
      return 'success';
    case 'PENDING':
    case 'HELD':
    case 'AWAITING_PAYMENT':
    // PENDING_PAYMENT is the status the API actually emits for an unpaid hold; the three
    // above are older or hypothetical spellings. Without it, the one state that genuinely
    // needs the user to act rendered in the neutral grey reserved for statuses this app
    // has never heard of. Seen on a real QA booking, not in a fixture.
    case 'PENDING_PAYMENT':
    case 'PARTIALLY_REFUNDED':
    case 'DISPUTED':
      return 'warning';
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
    case 'REFUNDED':
      return 'error';
    default:
      return 'neutral';
  }
}

/**
 * Whether a booking is still something the customer holds, rather than a dead record.
 *
 * Drives the Upcoming/Past split. The split is otherwise by session time, which is right
 * for live bookings — but a lapsed hold for a future date is not "upcoming" in any sense
 * a person means it. On a real QA account this put two EXPIRED holds in the Upcoming tab
 * and counted them in the badge, so the tab read "Upcoming (3)" when exactly one ticket
 * existed. An overstated count on the surface people open to check they have a ticket is
 * worse than a slightly over-full Past tab.
 *
 * Matched by exclusion so an unrecognised status from a newer API stays visible as live
 * rather than silently vanishing from both tabs.
 */
export function isLiveBooking(status: string): boolean {
  switch (status.toUpperCase()) {
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
    // A fully refunded booking admits nobody, so it is not "upcoming" either.
    case 'REFUNDED':
      return false;
    default:
      return true;
  }
}

/**
 * Whether this viewer can present the ticket at the gate. The server withholds the token
 * (null) from a viewer who may see a ticket but not use it; missing or empty counts as
 * withheld.
 */
export function canPresentTicket(ticket: { qrToken?: string | null }): boolean {
  return typeof ticket.qrToken === 'string' && ticket.qrToken.length > 0;
}

/** Words for a booking status, so the screen never shows a raw enum like PENDING_PAYMENT. */
export function bookingStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case 'CONFIRMED':
      return 'Confirmed';
    case 'PENDING_PAYMENT':
      return 'Waiting for payment';
    case 'PARTIALLY_REFUNDED':
      return 'Partly refunded';
    case 'REFUNDED':
      return 'Refunded';
    case 'CANCELLED':
      return 'Cancelled';
    case 'EXPIRED':
      return 'Expired';
    case 'DISPUTED':
      return 'Payment disputed';
    default:
      return status;
  }
}

/**
 * What a ticket's status means at the door. The API's TicketStatus is ACTIVE,
 * TRANSFERRED, CHECKED_IN, CANCELLED, REFUNDED or VOID. The app used to test for
 * "VALID", which the API never sends, so every good ticket showed as grey; and it
 * showed the QR for every status, so a refunded ticket looked usable.
 *
 * Only ACTIVE shows a code. CHECKED_IN keeps it hidden too: the ticket has been used,
 * and a second scan would be refused at the gate anyway.
 */
export function ticketState(status: string): {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
  showCode: boolean;
} {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return { label: 'Valid', tone: 'success', showCode: true };
    case 'CHECKED_IN':
      return { label: 'Checked in', tone: 'neutral', showCode: false };
    case 'TRANSFERRED':
      return { label: 'Transferred', tone: 'neutral', showCode: false };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'error', showCode: false };
    case 'REFUNDED':
      return { label: 'Refunded', tone: 'error', showCode: false };
    case 'VOID':
      return { label: 'Void', tone: 'error', showCode: false };
    default:
      // A status this build does not know. Show it as itself and do not offer a code
      // the gate may refuse.
      return { label: status, tone: 'neutral', showCode: false };
  }
}
