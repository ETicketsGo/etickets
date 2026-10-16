'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, LogIn, Ticket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  api,
  ApiRequestError,
  BrandButton,
  brandButtonClasses,
  REVIEW_COMMENT_MAX,
  useIsAuthenticated,
  type MyMovieReview,
} from '@eticketsgo/web-kit';
import { RatingStars, Skeleton, Textarea, useToast } from '@/components/ui';
import { Link } from '@/i18n/navigation';

/** Query keys the ratings feature reads and refreshes. */
export const movieReviewKeys = {
  summary: (slug: string) => ['movie-reviews', slug] as const,
  mine: (slug: string) => ['movie-review-mine', slug] as const,
};

/* A sunken block on the brand layer: an inset place to act, not a third card level. */
const panel = 'rounded-brand-card bg-brand-sunken p-4';
const panelTitle = 'font-brand-display text-brand-card text-brand-ink';
const panelText = 'text-brand-ui text-brand-ink-2';

/**
 * Where a viewer rates the film, or learns why they cannot yet.
 *
 * Three honest states before the form: signed out, never booked it, and booked but the show
 * has not started. Each says what would change the answer rather than hiding the panel, so
 * nobody wonders where the rate button went.
 */
export function RateMoviePanel({ slug }: { slug: string }) {
  const t = useTranslations('showtimes.reviews.rate');
  const authed = useIsAuthenticated();

  const mine = useQuery({
    queryKey: movieReviewKeys.mine(slug),
    queryFn: () => api.reviews.mineForMovie(slug),
    enabled: authed,
    retry: false,
  });

  if (!authed) {
    return (
      <div className={panel}>
        <p className={panelTitle}>{t('title')}</p>
        <p className={`mt-1 ${panelText}`}>{t('signedOut')}</p>
        <Link
          href={`/login?next=${encodeURIComponent(`/movies/${slug}#ratings`)}`}
          className={`mt-3 ${brandButtonClasses('secondary', 'md')}`}
        >
          <LogIn className="h-4 w-4" aria-hidden />
          {t('signIn')}
        </Link>
      </div>
    );
  }

  if (mine.isLoading) {
    return (
      <div className={`${panel} space-y-3`} aria-busy="true">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (mine.isError || !mine.data) {
    return (
      <div className={panel}>
        <p className={panelText}>{t('checkError')}</p>
        <RetryButton onRetry={() => mine.refetch()} />
      </div>
    );
  }

  const { review, eligibleEventId, reason } = mine.data;

  if (!eligibleEventId) {
    const notStarted = reason === 'NOT_STARTED';
    const Icon = notStarted ? CalendarClock : Ticket;
    return (
      <div className={panel}>
        <p className={panelTitle}>{review ? t('updateTitle') : t('title')}</p>
        {review && (
          <p className={`mt-1 ${panelText}`}>{t('yourRatingIs', { rating: review.rating })}</p>
        )}
        <p className={`mt-1 flex items-start gap-2 ${panelText}`}>
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-ink-3" aria-hidden />
          {notStarted ? t('notStarted') : t('noBooking')}
        </p>
      </div>
    );
  }

  return <RateForm slug={slug} eventId={eligibleEventId} review={review} />;
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const tx = useTranslations('common');
  return (
    <BrandButton variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
      {tx('action.retry')}
    </BrandButton>
  );
}

function RateForm({
  slug,
  eventId,
  review,
}: {
  slug: string;
  eventId: string;
  review: MyMovieReview['review'];
}) {
  const t = useTranslations('showtimes.reviews.rate');
  const qc = useQueryClient();
  const toast = useToast();
  const commentId = useId();
  const statusId = useId();

  const [rating, setRating] = useState(review?.rating ?? 0);
  const [comment, setComment] = useState(review?.comment ?? '');

  // A rating that arrives after first paint (a refetch after submitting) refills the form.
  useEffect(() => {
    if (review) {
      setRating(review.rating);
      setComment(review.comment ?? '');
    }
  }, [review]);

  const submit = useMutation({
    mutationFn: () =>
      api.reviews.create({
        eventId,
        rating,
        comment: comment.trim() ? comment.trim() : undefined,
      }),
    onSuccess: () => {
      toast.push(review ? t('updated') : t('thanks'), 'success');
      /*
        The film's rating is also carried by the hero (through the showtimes query) and by
        every poster card (through the movie lists), so those are refreshed too — otherwise
        the section says 4.4 while the chip right above it still says 4.3.
      */
      qc.invalidateQueries({ queryKey: movieReviewKeys.summary(slug) });
      qc.invalidateQueries({ queryKey: movieReviewKeys.mine(slug) });
      qc.invalidateQueries({ queryKey: ['movie-shows', slug] });
      qc.invalidateQueries({ queryKey: ['movies'] });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'REVIEW_NOT_ELIGIBLE') {
        // Eligibility changed under the form (a refund, say): re-ask so the panel explains why.
        toast.push(t('notEligible'), 'error');
        qc.invalidateQueries({ queryKey: movieReviewKeys.mine(slug) });
        return;
      }
      toast.push(error instanceof ApiRequestError ? error.message : t('failed'), 'error');
    },
  });

  return (
    <form
      className={`${panel} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        if (rating >= 1) submit.mutate();
      }}
    >
      <p className={panelTitle}>{review ? t('updateTitle') : t('title')}</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <RatingStars value={rating} onChange={setRating} size="lg" label={t('yourRating')} />
        <p id={statusId} aria-live="polite" className={panelText}>
          {rating >= 1 ? t(`words.${rating}`) : t('pick')}
        </p>
      </div>

      <Textarea
        id={commentId}
        label={t('comment')}
        rows={3}
        maxLength={REVIEW_COMMENT_MAX}
        placeholder={t('placeholder')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        hint={t('counter', { used: comment.length, max: REVIEW_COMMENT_MAX })}
      />

      <BrandButton
        type="submit"
        disabled={rating < 1 || submit.isPending}
        aria-busy={submit.isPending || undefined}
        aria-describedby={rating < 1 ? statusId : undefined}
      >
        {review ? t('update') : t('submit')}
      </BrandButton>
    </form>
  );
}
