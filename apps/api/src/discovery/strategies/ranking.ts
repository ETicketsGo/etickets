/**
 * Pure, deterministic ranking used by Trending/Popular (and re-usable by any
 * future strategy). A candidate's score blends two normalised signals:
 *
 *   • popularity — confirmed bookings (or any provided count), and
 *   • soonness   — how soon its next session starts (sooner ranks higher).
 *
 * Both signals are mapped into [0, 1) so the blend is stable regardless of
 * absolute magnitudes. No I/O, no Date.now() — `now` is always passed in — so
 * the ranking is fully unit-testable. The AI RecommendationEngine port can
 * later re-rank on top of this deterministic baseline.
 */

export interface RankSignals {
  /** Popularity count (e.g. confirmed bookings). Negative values clamp to 0. */
  bookings: number;
  /** Start of the next session, or null when unknown/none. */
  nextSessionAt: Date | string | null;
}

export interface RankWeights {
  popularity: number;
  soonness: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = { popularity: 0.6, soonness: 0.4 };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Diminishing-returns constant: at K bookings the popularity score is 0.5. */
const POPULARITY_K = 10;

/** Popularity in [0, 1): bookings / (bookings + K). Monotonic, saturating. */
export function popularityScore(bookings: number): number {
  const n = bookings > 0 ? bookings : 0;
  return n / (n + POPULARITY_K);
}

/**
 * Soonness in [0, 1]: a session starting right now scores ~1 and decays toward
 * 0 the further in the future it is. Past/unknown sessions score 0 so they
 * never out-rank an upcoming one purely on recency.
 */
export function soonnessScore(nextSessionAt: Date | string | null, now: Date): number {
  if (nextSessionAt == null) return 0;
  const t =
    nextSessionAt instanceof Date ? nextSessionAt.getTime() : new Date(nextSessionAt).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (t - now.getTime()) / DAY_MS;
  if (days < 0) return 0;
  return 1 / (1 + days);
}

/** Blended score in [0, 1). Higher is better. */
export function rankScore(
  signals: RankSignals,
  now: Date,
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
): number {
  return (
    weights.popularity * popularityScore(signals.bookings) +
    weights.soonness * soonnessScore(signals.nextSessionAt, now)
  );
}

/**
 * Return a NEW array of the items ordered by descending blended score. Stable
 * and deterministic: ties break by popularity, then by original position so the
 * result never depends on the input array's identity. Does not mutate input.
 */
export function rankBySignals<T>(
  items: T[],
  signalOf: (item: T) => RankSignals,
  now: Date,
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
): T[] {
  return items
    .map((item, index) => {
      const signals = signalOf(item);
      return { item, index, score: rankScore(signals, now, weights), bookings: signals.bookings };
    })
    .sort((a, b) => b.score - a.score || b.bookings - a.bookings || a.index - b.index)
    .map((e) => e.item);
}
