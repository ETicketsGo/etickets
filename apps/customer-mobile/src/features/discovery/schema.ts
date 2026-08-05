import { z } from 'zod';

/**
 * Runtime contract for the public discovery endpoints.
 *
 * These are Zod schemas rather than plain TypeScript interfaces because the mobile app
 * is the one client that CANNOT be redeployed in step with the API. A web app picks up
 * a changed response on its next page load; a phone can be running a build from three
 * months ago. Parsing means a field that disappeared surfaces as one handled error on
 * one section, instead of `undefined.city` crashing the whole Home screen.
 *
 * They also fill a real gap: these responses are inferred Prisma projections on the API
 * side, so they are not expressed as shared types anywhere. This file is the mobile
 * client's written-down expectation of them, checked on every response.
 *
 * Shapes verified against the QA API on 2026-08-04.
 */

export const venueSchema = z.object({
  name: z.string(),
  city: z.string(),
  country: z.string(),
});

/** A bookable event/experience as it appears in a list. */
export const eventSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  category: z.string(),
  venue: venueSchema,
  organizer: z.string(),
  /** ISO timestamp of the soonest upcoming session, or null if none is scheduled. */
  nextSessionAt: z.string().nullable(),
  /** Cheapest ticket, in MINOR units (paise/cents). Never render this unformatted. */
  fromPriceMinor: z.number().nullable(),
  currency: z.string(),
});

export const movieSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  posterUrl: z.string().nullable(),
  certificate: z.string().nullable(),
  language: z.string().nullable(),
  genres: z.array(z.string()),
  runtimeMinutes: z.number().nullable(),
});

export const discoverySchema = z.object({
  nowShowing: z.array(movieSummarySchema),
  trendingEvents: z.array(eventSummarySchema),
  thisWeekend: z.array(eventSummarySchema),
  categories: z.array(z.string()),
});

export const categoryCountSchema = z.object({
  category: z.string(),
  count: z.number(),
});

/** Envelope shared by every paginated list endpoint. */
export const paginationMetaSchema = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

export const eventPageSchema = z.object({
  data: z.array(eventSummarySchema),
  meta: paginationMetaSchema,
});

export type Venue = z.infer<typeof venueSchema>;
export type EventSummary = z.infer<typeof eventSummarySchema>;
export type MovieSummary = z.infer<typeof movieSummarySchema>;
export type Discovery = z.infer<typeof discoverySchema>;
export type CategoryCount = z.infer<typeof categoryCountSchema>;
export type EventPage = z.infer<typeof eventPageSchema>;
