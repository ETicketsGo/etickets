/**
 * Declared API gaps for the cinema journey.
 *
 * This file exists so a missing backend capability is a typed, testable value the UI
 * branches on — not a comment, and not a screen that silently does nothing. When the
 * endpoint below ships, flip the flag and delete the boundary; nothing else changes.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * GAP: no public route from a movie to its bookable screenings.
 * Verified against QA on 2026-08-04.
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * What exists and works:
 *   GET /public/discovery                → `nowShowing[]` movie CATALOGUE entries
 *                                          (id, title, slug, posterUrl, certificate,
 *                                          language, genres, runtimeMinutes)
 *   GET /public/discovery/sections       → same movies under `new-releases`
 *   GET /public/events/:slug             → a MOVIE-type Event, WITH sessions and
 *                                          ticket types (200 OK, public)
 *   GET /public/shows/:sessionId/seats   → the full seat map (200 OK, public)
 *   POST /bookings {items:[{ticketTypeId, quantity, seatIds}]}  → seat-level hold
 *
 * What is missing — the single hop between the first group and the second:
 *   A movie's catalogue slug is "skyfront-protocol". Its bookable Event's slug is
 *   "skyfront-protocol-show-598484" (the suffix is random per seed/creation). Nothing
 *   public maps one to the other:
 *     - GET /movies/:movieId/shows          → 401 unauthenticated, 403 TENANT_FORBIDDEN
 *                                             for a customer. It is organizer-scoped.
 *     - GET /public/events                  → excludes experienceType=MOVIE entirely
 *                                             (returns 3 EVENT rows; the movie Event is
 *                                             not among them, and the query parameter
 *                                             is not in the endpoint's schema).
 *     - GET /public/events/skyfront-protocol → 404 EVENT_NOT_PUBLISHED (that slug is the
 *                                             movie, not the Event).
 *
 * So a customer can reach a seat map only if they already hold the Event slug. There is
 * no discovery path, which is why the poster on Home cannot lead anywhere yet.
 *
 * SMALLEST ADDITIVE CONTRACT THAT WOULD CLOSE IT (either one, backwards compatible):
 *
 *   Option A — one extra field, no new route. Add to each `nowShowing` item and to the
 *   `new-releases` section items:
 *       "bookableEventSlug": string | null
 *   null when the movie has no PUBLISHED movie-Event with a future session. The mobile
 *   client would then navigate straight to the existing /public/events/:slug screen and
 *   this whole boundary disappears.
 *
 *   Option B — a public showtimes route, needed anyway once one movie plays at several
 *   cinemas:
 *       GET /public/movies/:movieSlug/shows?city=&date=
 *       200 {
 *         movie: { id, title, slug, posterUrl, certificate, language, genres,
 *                  runtimeMinutes },
 *         cinemas: [{
 *           id, name, city,
 *           shows: [{ eventSlug, sessionId, startsAt, screenName, format,
 *                     seatsAvailable, seatsTotal }]
 *         }]
 *       }
 *   `seatsAvailable`/`seatsTotal` would also let the UI show a genuine "filling fast"
 *   state. Today nothing in any public response carries per-show availability, so that
 *   badge is deliberately NOT rendered rather than guessed at.
 *
 * Option A is the smaller change and unblocks the app; Option B is the one that scales.
 */
export const CINEMA_CAPABILITIES = {
  /**
   * Can the app go from a movie in discovery to its screenings?
   * Set to true once either option above ships, and delete the boundary UI.
   */
  publicShowtimesByMovie: false,

  /**
   * Does any public response expose per-show seat counts? Needed before a
   * "filling fast" or "N seats left" badge can be shown without inventing it.
   */
  publicShowAvailabilityCounts: false,

  /**
   * Does the seat map distinguish accessible / companion seating?
   * No: the Seat model has `kind` (SEAT | GAP) only, and even that is not projected
   * into the public response. Wheelchair spaces cannot be identified, so the app must
   * not imply it knows where they are.
   */
  accessibleSeatMetadata: false,
} as const;

export type CinemaCapability = keyof typeof CINEMA_CAPABILITIES;
