/**
 * Declared API gaps for the cinema journey.
 *
 * A typed, testable value the UI branches on — not a comment, and not a screen that
 * silently does nothing.
 *
 * CLOSED 2026-08-05: the movie→screenings gap. GET /public/movies/:slug and
 * GET /public/movies/:slug/shows now exist (apps/api/src/events/public-movies.service.ts),
 * so a poster leads all the way to a seat map. The flag below is kept, set to true, so
 * an older app build pointed at an API without those routes still has one place to turn
 * the journey off rather than failing per-screen.
 */
export const CINEMA_CAPABILITIES = {
  /** GET /public/movies/:slug/shows — shipped 2026-08-05. */
  publicShowtimesByMovie: true,

  /**
   * Per-show availability. Now supplied as AVAILABLE | LIMITED | SOLD_OUT, plus exact
   * seat counts for seat-based shows. "Filling fast" renders only from the server's
   * LIMITED — it is never inferred client-side.
   */
  publicShowAvailabilityCounts: true,

  /**
   * Does the seat map distinguish accessible / companion seating?
   * No: the Seat model has `kind` (SEAT | GAP) only, and even that is not projected
   * into the public response. Wheelchair spaces cannot be identified, so the app must
   * not imply it knows where they are.
   */
  accessibleSeatMetadata: false,
} as const;

export type CinemaCapability = keyof typeof CINEMA_CAPABILITIES;
