'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatRatingAverage, formatVoteCount, type MovieRating } from '@eticketsgo/web-kit';

/**
 * The words for a film's rating, identical on the poster card, the film hero and the ratings
 * section — one place decides that 1,234 votes reads "1.2K votes" and, to a screen reader,
 * "Rated 4.3 out of 5 by 1,234 people".
 */
export function useRatingText() {
  const t = useTranslations('showtimes.rating');
  const locale = useLocale();
  return {
    locale,
    /** "4.3" */
    average: (average: number) => formatRatingAverage(average, locale),
    /** "4.3/5" */
    outOf5: (average: number) => t('average', { average: formatRatingAverage(average, locale) }),
    /** "1.2K votes" */
    votes: (count: number) => t('votes', { count, votes: formatVoteCount(count, locale) }),
    /** "Rated 4.3 out of 5 by 1,234 people" — the exact count, for the accessible wording. */
    summary: (rating: MovieRating) =>
      t('summary', { average: formatRatingAverage(rating.average, locale), count: rating.count }),
  };
}
