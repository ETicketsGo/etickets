'use client';

import { useTranslations } from 'next-intl';
import type { ReviewItem } from '@eticketsgo/web-kit';
import { RatingStars } from '@/components/ui';
import { useFormat } from '@/lib/format';

/** The latest reviews, newest first as the API sends them: who, how many stars, when, what. */
export function RecentReviews({ items, total }: { items: ReviewItem[]; total: number }) {
  const t = useTranslations('showtimes.reviews');
  const { dateOnly } = useFormat();

  if (items.length === 0) return null;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-title font-semibold text-text-primary">{t('recent')}</h3>
        {total > items.length && (
          <p className="text-caption text-text-muted">
            {t('latestOf', { shown: items.length, count: total })}
          </p>
        )}
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-background-surface">
        {items.map((review) => (
          <li key={review.id} className="min-w-0 space-y-1.5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 break-words font-medium text-text-primary">
                {review.author}
              </span>
              <time dateTime={review.createdAt} className="text-caption text-text-muted">
                {dateOnly(review.createdAt)}
              </time>
            </div>
            <RatingStars value={review.rating} size="sm" />
            {review.comment && (
              <p className="whitespace-pre-line break-words text-[0.9375rem] leading-relaxed text-text-secondary">
                {review.comment}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
