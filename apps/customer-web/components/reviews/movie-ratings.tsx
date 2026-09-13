'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api, useIsAuthenticated } from '@eticketsgo/web-kit';
import { Button, Skeleton } from '@/components/ui';
import { RatingSummary } from './rating-summary';
import { RecentReviews } from './recent-reviews';
import { movieReviewKeys, RateMoviePanel } from './rate-movie-panel';

/**
 * The film page's "Ratings & reviews": the aggregate across every cinema, recent reviews, and
 * the place to rate.
 *
 * It loads on its own and fails on its own. The showtimes above are the reason somebody is on
 * this page, so a reviews outage is a line with a retry here, never an error that takes the
 * page with it.
 */
export function MovieRatings({ slug }: { slug: string }) {
  const t = useTranslations('showtimes.reviews');
  const tx = useTranslations('common');
  const sectionRef = useRef<HTMLElement>(null);

  const reviews = useQuery({
    queryKey: movieReviewKeys.summary(slug),
    queryFn: () => api.reviews.forMovie(slug),
  });

  /*
    Arriving at /movies/<slug>#ratings — from the hero chip on another visit, or back from
    sign-in — the browser looks for the anchor before this section exists, because the page
    renders a skeleton until the showtimes load. So the jump is made once the section mounts.
  */
  useEffect(() => {
    if (window.location.hash === '#ratings') sectionRef.current?.scrollIntoView();
  }, []);

  return (
    <section
      id="ratings"
      ref={sectionRef}
      aria-labelledby="ratings-heading"
      className="min-w-0 scroll-mt-24 space-y-4"
    >
      <h2 id="ratings-heading" className="text-h3 font-semibold text-text-primary">
        {t('heading')}
      </h2>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0 space-y-4">
          {reviews.isLoading ? (
            <div className="space-y-3" aria-busy="true">
              <span className="sr-only">{t('loading')}</span>
              <Skeleton className="h-12 w-40" />
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-2 w-full" />
              ))}
            </div>
          ) : reviews.isError || !reviews.data ? (
            <div className="rounded-lg border border-border bg-background-surface p-4">
              <p className="text-[0.9375rem] text-text-secondary">{t('loadError')}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => reviews.refetch()}
              >
                {tx('action.retry')}
              </Button>
            </div>
          ) : reviews.data.count > 0 ? (
            <RatingSummary summary={reviews.data} />
          ) : (
            <NoRatingsYet slug={slug} />
          )}

          <RateMoviePanel slug={slug} />
        </div>

        {reviews.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : reviews.data && reviews.data.count > 0 ? (
          <RecentReviews items={reviews.data.items} total={reviews.data.count} />
        ) : null}
      </div>
    </section>
  );
}

/**
 * "Be the first" only to someone who actually can be. Everyone else gets a neutral line —
 * inviting a person who never booked the film to rate it sends them to a form that refuses.
 */
function NoRatingsYet({ slug }: { slug: string }) {
  const t = useTranslations('showtimes.reviews');
  const authed = useIsAuthenticated();
  // Shares the panel's query, so this costs no second request.
  const mine = useQuery({
    queryKey: movieReviewKeys.mine(slug),
    queryFn: () => api.reviews.mineForMovie(slug),
    enabled: authed,
    retry: false,
  });
  const canRate = authed && !!mine.data?.eligibleEventId;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-background-surface p-4">
      <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      <div>
        <p className="font-semibold text-text-primary">
          {canRate ? t('firstTitle') : t('emptyTitle')}
        </p>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          {canRate ? t('firstHint') : t('emptyHint')}
        </p>
      </div>
    </div>
  );
}
