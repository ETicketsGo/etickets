'use client';

import { Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ratingDistribution, roundedStars, type ReviewSummary } from '@eticketsgo/web-kit';
import { RatingStars } from '@/components/ui';
import { useRatingText } from './use-rating-text';

/**
 * The big number, its stars, how many people it rests on, and the 5 → 1 breakdown.
 *
 * Every visual piece has a text twin. The star row rounds 4.3 to four stars, which is fine to
 * look at and wrong to announce, so it is hidden from assistive technology and the exact
 * sentence is read instead. Each bar is likewise read as "5 stars: 62 ratings (62%)" rather
 * than left as a width nobody can hear.
 */
export function RatingSummary({ summary }: { summary: ReviewSummary }) {
  const t = useTranslations('showtimes.reviews');
  const words = useRatingText();
  const buckets = ratingDistribution(summary.distribution);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-4">
        <p className="leading-none">
          <span className="sr-only">{words.summary(summary)}</span>
          <span
            aria-hidden
            className="font-brand-display text-[3rem] font-bold tabular-nums tracking-tight text-brand-ink"
          >
            {words.average(summary.average)}
          </span>
          <span aria-hidden className="ml-1 text-brand-figure-sm text-brand-ink-3">
            /5
          </span>
        </p>
        <div aria-hidden className="pb-1">
          <RatingStars value={roundedStars(summary.average)} size="md" />
          <p className="mt-1 text-brand-meta tabular-nums text-brand-ink-3">
            {t('totalRatings', { count: summary.count })}
          </p>
        </div>
      </div>

      <ul aria-label={t('breakdown')} className="space-y-1.5">
        {buckets.map((bucket) => (
          <li key={bucket.stars} className="flex items-center gap-2 text-brand-meta">
            <span className="sr-only">
              {t('breakdownRow', {
                stars: bucket.stars,
                count: bucket.count,
                percent: bucket.percent,
              })}
            </span>
            <span
              aria-hidden
              className="flex w-8 shrink-0 items-center gap-0.5 tabular-nums text-brand-ink-2"
            >
              {bucket.stars}
              <Star className="h-3 w-3 fill-current text-brand-ink-2" />
            </span>
            <span aria-hidden className="h-2 flex-1 overflow-hidden rounded-full bg-brand-sunken">
              <span
                className="block h-full rounded-full bg-brand-ink"
                style={{ width: `${bucket.percent}%` }}
              />
            </span>
            <span aria-hidden className="w-10 shrink-0 text-right tabular-nums text-brand-ink-3">
              {t('percent', { percent: bucket.percent })}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-brand-meta text-brand-ink-3">{t('verified')}</p>
    </div>
  );
}
