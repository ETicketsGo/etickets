import { z } from 'zod';

/**
 * Runtime contract for the public cinema endpoints.
 *
 * Verified against a real API instance (local Postgres + the repo's seed) on
 * 2026-08-05, and mirrored from the DTOs in
 * apps/api/src/events/public-movies.service.ts.
 */

export const publicMovieSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  synopsis: z.string().nullable(),
  runtimeMinutes: z.number().int(),
  certificate: z.string().nullable(),
  language: z.string(),
  genres: z.array(z.string()),
  releaseDate: z.string().nullable(),
  posterUrl: z.string().nullable(),
  trailerUrl: z.string().nullable(),
  cast: z.array(z.string()),
  director: z.string().nullable(),
});

/**
 * Coarse availability from the server. Parsed as an open string rather than an enum so
 * a future state renders as "not bookable" instead of failing the whole list.
 */
export const showAvailabilitySchema = z.string();

export const publicShowSchema = z.object({
  sessionId: z.string(),
  eventId: z.string(),
  /** The bookable listing's slug — what /public/events/:slug wants. */
  eventSlug: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    city: z.string(),
    country: z.string(),
  }),
  cinema: z.object({ id: z.string(), name: z.string(), brand: z.string().nullable() }).nullable(),
  screen: z.object({ id: z.string(), name: z.string() }).nullable(),
  format: z.string().nullable(),
  language: z.string(),
  currency: z.string(),
  fromPriceMinor: z.number().int().nullable(),
  seatingType: z.string(),
  availability: showAvailabilitySchema,
  seatsAvailable: z.number().int().nullable(),
  seatsTotal: z.number().int().nullable(),
});

export const publicShowsResponseSchema = z.object({
  movie: publicMovieSchema,
  shows: z.array(publicShowSchema),
  filters: z.object({
    dates: z.array(z.string()),
    cities: z.array(z.string()),
    formats: z.array(z.string()),
    languages: z.array(z.string()),
  }),
  meta: z.object({ total: z.number(), returned: z.number(), limit: z.number() }),
});

export type PublicMovie = z.infer<typeof publicMovieSchema>;
export type PublicShow = z.infer<typeof publicShowSchema>;
export type PublicShowsResponse = z.infer<typeof publicShowsResponseSchema>;

export type ShowGroup = {
  /** Cinema id, or the venue id when the screening has no cinema attached. */
  key: string;
  cinemaName: string;
  city: string;
  shows: PublicShow[];
};

/**
 * The calendar date of a screening, in the VIEWER's timezone.
 *
 * The API returns instants and no venue timezone, so it cannot supply a local date and
 * deliberately does not try. Grouping therefore happens here, against the device's own
 * zone — which is right for the overwhelmingly common case of someone booking a cinema
 * near them, and wrong only for a traveller booking across a date boundary in another
 * country. Fixing that properly needs `Venue.timezone` on the API.
 */
export function localDateKey(iso: string): string {
  const date = new Date(iso);
  // Local components, not toISOString() — that would re-introduce UTC.
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Distinct viewer-local dates present in a show list, ascending. */
export function availableDates(shows: PublicShow[]): string[] {
  return [...new Set(shows.map((s) => localDateKey(s.startsAt)))].sort();
}

/**
 * Group screenings by cinema, preserving time order within each.
 *
 * Cinemas are ordered by their earliest remaining screening rather than by name: a user
 * scanning for "what can I still get to today" is served by soonest-first, and an
 * alphabetical list buries it.
 */
export function groupShowsByCinema(shows: PublicShow[]): ShowGroup[] {
  const groups = new Map<string, ShowGroup>();

  for (const show of shows) {
    const key = show.cinema?.id ?? show.venue.id;
    const existing = groups.get(key);
    if (existing) {
      existing.shows.push(show);
      continue;
    }
    groups.set(key, {
      key,
      cinemaName: show.cinema?.name ?? show.venue.name,
      city: show.venue.city,
      shows: [show],
    });
  }

  for (const group of groups.values()) {
    group.shows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  return [...groups.values()].sort((a, b) =>
    a.shows[0].startsAt.localeCompare(b.shows[0].startsAt),
  );
}

/** A screening that cannot be booked. Anything unrecognised counts as unbookable. */
export function isShowBookable(show: PublicShow): boolean {
  return show.availability === 'AVAILABLE' || show.availability === 'LIMITED';
}
