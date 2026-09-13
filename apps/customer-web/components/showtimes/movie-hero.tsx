'use client';

import { Clock, Film, Play, Star } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { gradientFor, hasRating, type PublicMovieShows } from '@eticketsgo/web-kit';
import { Badge } from '@/components/ui';
import { useRatingText } from '@/components/reviews/use-rating-text';
import { focusRing } from './styles';

/** Long enough that three lines would cut it off; below this there is nothing to expand. */
const LONG_SYNOPSIS = 240;

const tag =
  'inline-flex items-center gap-1 rounded-full border border-border bg-background-surface px-2.5 py-0.5 text-caption text-text-secondary';

/**
 * The film: poster, title, the facts people decide on, and the synopsis.
 *
 * On a phone the poster sits beside the title rather than above it, so the date strip is still
 * reachable without scrolling past a full-width poster.
 */
export function MovieHero({ movie }: { movie: PublicMovieShows['movie'] }) {
  const t = useTranslations('showtimes.movie');
  const tr = useTranslations('showtimes.rating');
  const words = useRatingText();
  const rating = hasRating(movie.rating) ? movie.rating : null;
  const [expanded, setExpanded] = useState(false);
  /*
    A poster URL that does not load shows the placeholder, not a broken image with its alt text
    spilling over the frame — which is what an unreachable poster host did on the film page.
  */
  const [posterFailed, setPosterFailed] = useState(false);
  const synopsisId = useId();

  const hours = Math.floor(movie.runtimeMinutes / 60);
  const minutes = movie.runtimeMinutes % 60;
  const runtime =
    movie.runtimeMinutes <= 0
      ? null
      : hours === 0
        ? t('minutesOnly', { minutes })
        : minutes === 0
          ? t('hoursOnly', { hours })
          : t('hoursMinutes', { hours, minutes });

  // Organizer-entered: only ever a web page, never a `javascript:` URL.
  const trailer =
    movie.trailerUrl && /^https?:\/\//i.test(movie.trailerUrl) ? movie.trailerUrl : null;
  const longSynopsis = (movie.synopsis?.length ?? 0) > LONG_SYNOPSIS;
  const hasDetails = Boolean(movie.synopsis || movie.director || movie.cast.length > 0);

  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-x-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="self-start overflow-hidden rounded-lg border border-border bg-background-subtle shadow-sm sm:row-span-2">
        <div className="aspect-[2/3] w-full">
          {movie.posterUrl && !posterFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={movie.posterUrl}
              alt={t('poster', { title: movie.title })}
              onError={() => setPosterFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${gradientFor(movie.id)}`}
            >
              <Film className="h-10 w-10 text-text-primary/25" aria-hidden />
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 self-center sm:self-end">
        <div className="flex flex-wrap items-center gap-2">
          {movie.certificate && (
            <Badge tone="neutral">
              <span className="sr-only">{t('certificate')}: </span>
              {movie.certificate}
            </Badge>
          )}
          <Badge tone="info">
            <span className="sr-only">{t('language')}: </span>
            {movie.language}
          </Badge>
          {rating && (
            /*
              A link to the ratings section rather than a static badge: the number invites
              "says who?", and the answer — the breakdown and the reviews — is further down.
              A solid tint so its contrast is a fixed pair (see tokens.css), not a wash.
            */
            <a
              href="#ratings"
              className={`inline-flex items-center gap-1.5 rounded-full bg-tint-warning px-2.5 py-0.5 text-caption font-medium text-text-primary hover:underline ${focusRing}`}
            >
              <Star className="h-3.5 w-3.5 fill-status-warning text-status-warning" aria-hidden />
              <span aria-hidden className="tabular-nums">
                <span className="font-semibold">{words.outOf5(rating.average)}</span>
                {' · '}
                {words.votes(rating.count)}
              </span>
              <span className="sr-only">
                {words.summary(rating)}. {tr('jump')}
              </span>
            </a>
          )}
        </div>
        <h1 className="mt-2 break-words text-h3 font-bold tracking-tight text-text-primary sm:text-h1">
          {movie.title}
        </h1>
        {(runtime || movie.genres.length > 0) && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {runtime && (
              <li className={tag}>
                <Clock className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">{t('runtime')}: </span>
                {runtime}
              </li>
            )}
            {movie.genres.map((genre) => (
              <li key={genre} className={tag}>
                {genre}
              </li>
            ))}
          </ul>
        )}
        {trailer && (
          <a
            href={trailer}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-border-input bg-background-surface px-3.5 text-button font-semibold text-text-primary hover:bg-background-subtle motion-safe:transition-colors ${focusRing}`}
          >
            <Play className="h-4 w-4" aria-hidden />
            {t('trailer')}
            <span className="sr-only"> {t('opensInNewTab')}</span>
          </a>
        )}
      </div>

      {hasDetails && (
        <div className="col-span-2 min-w-0 max-w-prose space-y-3 sm:col-span-1 sm:col-start-2">
          {movie.synopsis && (
            <div>
              <p
                id={synopsisId}
                className={`whitespace-pre-line leading-relaxed text-text-secondary ${
                  longSynopsis && !expanded ? 'line-clamp-3' : ''
                }`}
              >
                {movie.synopsis}
              </p>
              {longSynopsis && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={synopsisId}
                  onClick={() => setExpanded((v) => !v)}
                  className={`mt-1 rounded-sm text-caption font-semibold text-text-primary underline underline-offset-2 ${focusRing}`}
                >
                  {expanded ? t('readLess') : t('readMore')}
                </button>
              )}
            </div>
          )}
          {(movie.director || movie.cast.length > 0) && (
            <dl className="space-y-1 text-[0.9375rem]">
              {movie.director && (
                <div className="flex gap-2">
                  <dt className="shrink-0 font-medium text-text-primary">{t('director')}</dt>
                  <dd className="min-w-0 text-text-secondary">{movie.director}</dd>
                </div>
              )}
              {movie.cast.length > 0 && (
                <div className="flex gap-2">
                  <dt className="shrink-0 font-medium text-text-primary">{t('cast')}</dt>
                  <dd className="min-w-0 text-text-secondary">{movie.cast.join(', ')}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
