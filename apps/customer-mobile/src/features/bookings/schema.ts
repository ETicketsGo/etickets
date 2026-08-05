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
  event: z.object({ title: z.string(), slug: z.string() }),
  eventSession: z.object({ startsAt: z.string() }),
  _count: z.object({ tickets: z.number() }),
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
   */
  qrToken: z.string(),
  /** Server-rendered QR as a data: URI. This is what gets displayed and cached. */
  qrDataUrl: z.string(),
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
