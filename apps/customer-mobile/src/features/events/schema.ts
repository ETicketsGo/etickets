import { z } from 'zod';
import { eventImageFields } from './event-image';

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
  /**
   * ON_SALE, or why not: NOT_YET (with salesStartAt) or CLOSED. Only ON_SALE can be picked;
   * the app used to offer a stepper for a tier the server would refuse at checkout.
   */
  saleState: z.string().nullish(),
  salesStartAt: z.string().nullish(),
});

export const sessionSchema = z.object({
  id: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.string(),
  /**
   * This session sells named seats, and the API refuses a booking line without seatIds.
   *
   * A fact about the SESSION, not the event: a theatre tour can play a seated hall on one
   * date and a standing room on the next. Optional because an older API did not send it;
   * absent means "not known", never "not seated" — see requiresSeatSelection.
   */
  seatBased: z.boolean().optional(),
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
  /**
   * DEMO or TEST on catalogue the platform seeded for QA. The website labels it "Sample
   * event" / "Test event"; the app does the same, so nobody books a showcase by mistake.
   */
  contentLabel: z.string().nullish(),
  /** The venue's IANA zone. Session times are printed in it. */
  timeZone: z.string().nullish(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    city: z.string(),
    // Venue.country is nullable in the API. Required here, one venue with no country
    // failed the parse of the whole list or page.
    country: z.string().nullish(),
    address: z.string().nullable(),
  }),
  organizer: z.object({ id: z.string(), name: z.string(), verified: z.boolean().nullish() }),
  /** Free events skip payment entirely (declared by the organizer, not inferred). */
  isFree: z.boolean().nullish(),
  /** Minimum age, when the organizer set one. */
  ageLimit: z.number().int().nullish(),
  termsAndConditions: z.string().nullish(),
  artists: z.array(z.object({ name: z.string() })).nullish(),
  sessions: z.array(sessionSchema),
  /** The event's picture, when it has one. See event-image.ts for why both are optional. */
  ...eventImageFields,
});

export type TicketType = z.infer<typeof ticketTypeSchema>;
export type EventSession = z.infer<typeof sessionSchema>;
export type EventDetail = z.infer<typeof eventDetailSchema>;

/** Whether a ticket type can be picked now. An older API without saleState means yes. */
export function isOnSale(t: Pick<TicketType, 'saleState'>): boolean {
  return !t.saleState || t.saleState.toUpperCase() === 'ON_SALE';
}
