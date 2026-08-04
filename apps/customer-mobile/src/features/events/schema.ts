import { z } from 'zod';

/**
 * Runtime contract for GET /public/events/:slug.
 * Verified against the QA API on 2026-08-04.
 */

export const ticketTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Integer minor units. */
  priceMinor: z.number().int(),
  currency: z.string(),
  /** Hard per-order cap the API enforces; the stepper must not exceed it. */
  maxPerOrder: z.number().int(),
  /** Remaining inventory. Authoritative at read time only — see the note in cart.ts. */
  available: z.number().int(),
});

export const sessionSchema = z.object({
  id: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.string(),
  ticketTypes: z.array(ticketTypeSchema),
});

export const eventDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  experienceType: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  refundPolicy: z.string().nullable(),
  /**
   * CUSTOMER_PAYS or ORGANIZER_PAYS. Decides whether platform fees are added on top of
   * the ticket price or absorbed — the difference between the listed price and the
   * charged price, so it must never be guessed at client-side. The checkout total
   * always comes from the API's own quote.
   */
  feeMode: z.string(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    city: z.string(),
    country: z.string(),
    address: z.string().nullable(),
  }),
  organizer: z.object({ id: z.string(), name: z.string() }),
  sessions: z.array(sessionSchema),
});

export type TicketType = z.infer<typeof ticketTypeSchema>;
export type EventSession = z.infer<typeof sessionSchema>;
export type EventDetail = z.infer<typeof eventDetailSchema>;
