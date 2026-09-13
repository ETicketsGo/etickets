'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, LogIn, Ticket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  api,
  ApiRequestError,
  REVIEW_COMMENT_MAX,
  useIsAuthenticated,
  type MyMovieReview,
} from '@eticketsgo/web-kit';
import { Button, ButtonLink, RatingStars, Skeleton, Textarea, useToast } from '@/components/ui';

/** Query keys the ratings feature reads and refreshes. */
export const movieReviewKeys = {
  summary: (slug: string) => ['movie-reviews', slug] as const,
  mine: (slug: string) => ['movie-review-mine', slug] as const,
};

const panel = 'rounded-lg border border-border bg-background-subtle p-4';

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
        <p className="font-semibold text-text-primary">{t('title')}</p>
        <p className="mt-1 text-[0.9375rem] text-text-secondary">{t('signedOut')}</p>
        <ButtonLink
          href={`/login?next=${encodeURIComponent(`/movies/${slug}#ratings`)}`}
          variant="secondary"
          size="sm"
          className="mt-3"
        >
          <LogIn className="h-4 w-4" aria-hidden />
          {t('signIn')}
        </ButtonLink>
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
        <p className="text-[0.9375rem] text-text-secondary">{t('checkError')}</p>
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
        <p className="font-semibold text-text-primary">{review ? t('updateTitle') : t('title')}</p>
        {review && (
          <p className="mt-1 text-[0.9375rem] text-text-secondary">
            {t('yourRatingIs', { rating: review.rating })}
          </p>
        )}
        <p className="mt-1 flex items-start gap-2 text-[0.9375rem] text-text-secondary">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
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
    <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
      {tx('action.retry')}
    </Button>
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
      <p className="font-semibold text-text-primary">{review ? t('updateTitle') : t('title')}</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <RatingStars value={rating} onChange={setRating} size="lg" label={t('yourRating')} />
        <p id={statusId} aria-live="polite" className="text-[0.9375rem] text-text-secondary">
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

      <Button
        type="submit"
        loading={submit.isPending}
        disabled={rating < 1}
        aria-describedby={rating < 1 ? statusId : undefined}
      >
        {review ? t('update') : t('submit')}
      </Button>
    </form>
  );
}
