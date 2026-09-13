import type { MovieRating } from './api';

/**
 * Film ratings, formatted the way a storefront shows them: "★ 4.3/5 · 1.2K votes".
 *
 * Ratings are 1–5 stars from people who booked and watched the film, displayed out of 5. They
 * are never stretched to /10 — a 4.3 shown as 8.6 claims a precision the scale never had.
 */

/** The longest review comment the API accepts. */
export const REVIEW_COMMENT_MAX = 1000;

/** The API's scale. */
export const RATING_SCALE = 5;

/**
 * Whether a rating exists to show.
 *
 * A film nobody has rated shows NO rating, never "0/5": zero reads as "terrible", not as
 * "unrated", and an older API sends no `rating` field at all.
 */
export function hasRating(rating: MovieRating | null | undefined): rating is MovieRating {
  return !!rating && Number.isFinite(rating.count) && rating.count > 0;
}

/**
 * A vote count, compact from a thousand up: "999", "1.2K", "22.4K", "1.5M" (French "1,2 k").
 *
 * ── WHY TRUNCATED, NOT ROUNDED ─────────────────────────────────────────────────────
 * Rounding reports 1,150 votes as "1.2K" — fifty people who never voted. A vote count is a
 * claim about how many people stand behind a number, so it may understate but must not
 * overstate. Below a thousand the exact figure fits, so there is nothing to abbreviate.
 */
export function formatVoteCount(count: number, locale = 'en'): string {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (n < 1000) return new Intl.NumberFormat(locale).format(n);
  // `roundingMode` is ES2023; an engine without it ignores the option and rounds instead.
  const options = {
    notation: 'compact',
    maximumFractionDigits: 1,
    roundingMode: 'trunc',
  } as Intl.NumberFormatOptions;
  return new Intl.NumberFormat(locale, options).format(n);
}

/** The average to one decimal in the reader's language: "4.3", "5.0", French "4,3". */
export function formatRatingAverage(average: number, locale = 'en'): string {
  const value = Math.min(RATING_SCALE, Math.max(0, Number.isFinite(average) ? average : 0));
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/** Whole stars for a star row that cannot draw fractions: 4.3 → 4, 4.5 → 5. */
export function roundedStars(average: number): number {
  if (!Number.isFinite(average)) return 0;
  return Math.min(RATING_SCALE, Math.max(0, Math.round(average)));
}

export interface RatingBucket {
  stars: 1 | 2 | 3 | 4 | 5;
  count: number;
  /** Whole percent of all ratings. The five buckets sum to exactly 100 when anyone rated. */
  percent: number;
}

/**
 * The 5 → 1 breakdown, with percentages that add up.
 *
 * Rounding each bucket on its own shows 33% + 33% + 33% for three even votes, which a reader
 * rightly adds up and distrusts. Largest remainder gives the missing point to the bucket that
 * lost the most in rounding, so the column always totals 100. The denominator is the buckets'
 * own sum, so the bars agree with each other even if a stale `count` does not.
 */
export function ratingDistribution(distribution: Record<string, number> | null | undefined) {
  const order = [5, 4, 3, 2, 1] as const;
  const counts = order.map((stars) => {
    const raw = Number(distribution?.[String(stars)] ?? 0);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  });
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total === 0) {
    return order.map((stars): RatingBucket => ({ stars, count: 0, percent: 0 }));
  }

  const exact = counts.map((c) => (c * 100) / total);
  const percents = exact.map(Math.floor);
  let missing = 100 - percents.reduce((sum, p) => sum + p, 0);
  // Ties go to the higher star, which is first in the order — stable and deterministic.
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (missing <= 0) break;
    percents[index] += 1;
    missing -= 1;
  }

  return order.map((stars, i): RatingBucket => ({ stars, count: counts[i], percent: percents[i] }));
}
