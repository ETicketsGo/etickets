'use client';

import { Clock, Film, Play, Star } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BRAND_FOCUS, hasRating, type PublicMovieShows } from '@eticketsgo/web-kit';
import { useRatingText } from '@/components/reviews/use-rating-text';

/* On the stage band the focus ring is the marigold light, offset from the dark canvas. */
const focusRing = `${BRAND_FOCUS} focus-visible:ring-offset-brand-canvas`;

/** Long enough that three lines would cut it off; below this there is nothing to expand. */
const LONG_SYNOPSIS = 240;

/* A fact about the film, as a quiet outlined tag. Never a coloured badge: no category colours. */
const tag =
  'inline-flex h-7 items-center gap-1 rounded-full border border-brand-line-strong px-3 text-brand-meta font-medium text-brand-ink-2';

/**
 * The film: poster, title, the facts people decide on, and the synopsis.
 *
 * On a phone the poster sits beside the title rather than above it, so the date strip is still
 * reachable without scrolling past a full-width poster.
 *
 * A stage band (docs/design/DESIGN-SYSTEM.md): the film header is one of the places the
 * storefront dims the lights. It carries its own `data-brand` because the rest of the film page
 * (the showtimes) has not moved to the brand layer yet, and reaches the page column's edges so
 * it reads as a band rather than a card.
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
    <div data-brand="customer" className="-mx-4 -mt-6 font-brand-text sm:-mx-6 sm:-mt-10 lg:-mx-8">
      <div
        data-brand-tone="stage"
        className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 bg-brand-canvas px-4 pb-8 pt-6 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-x-8 sm:px-6 sm:pb-10 sm:pt-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:px-10"
      >
        <div className="self-start overflow-hidden rounded-brand-card bg-brand-sunken sm:row-span-2">
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
              /*
              No poster: the title set as artwork on the stage colour with a marigold rule - the
              brand's no-image fallback (EventArtwork's), never a coloured gradient.
            */
              <div className="flex h-full w-full flex-col justify-end gap-2 p-[10%]">
                <Film className="h-6 w-6 text-brand-ink-3" aria-hidden />
                <span className="line-clamp-4 font-brand-display text-brand-card text-brand-ink">
                  {movie.title}
                </span>
                <span aria-hidden className="h-1 w-8 rounded-full bg-brand-marigold" />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 self-center sm:self-end">
          <div className="flex flex-wrap items-center gap-2">
            {movie.certificate && (
              <span className={tag}>
                <span className="sr-only">{t('certificate')}: </span>
                {movie.certificate}
              </span>
            )}
            <span className={tag}>
              <span className="sr-only">{t('language')}: </span>
              {movie.language}
            </span>
            {rating && (
              /*
              A link to the ratings section rather than a static badge: the number invites
              "says who?", and the answer — the breakdown and the reviews — is further down.
              A solid tint so its contrast is a fixed pair (see tokens.css), not a wash.
            */
              <a
                href="#ratings"
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-brand-line-strong px-3 text-brand-meta font-medium text-brand-ink hover:underline ${focusRing}`}
              >
                <Star className="h-3.5 w-3.5 fill-brand-marigold text-brand-marigold" aria-hidden />
                <span aria-hidden className="tabular-nums">
                  <span className="font-semibold">{words.outOf5(rating.average)}</span>
                  {' - '}
                  {words.votes(rating.count)}
                </span>
                <span className="sr-only">
                  {words.summary(rating)}. {tr('jump')}
                </span>
              </a>
            )}
          </div>
          <h1 className="mt-3 break-words text-balance font-brand-display text-brand-d1 text-brand-ink">
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
              className={`mt-5 inline-flex h-11 items-center gap-2 rounded-brand-control border border-brand-line-strong px-4 text-brand-ui font-semibold text-brand-ink hover:border-brand-ink-3 motion-safe:transition-colors ${focusRing}`}
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
                  className={`whitespace-pre-line text-brand-body text-brand-ink-2 ${
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
                    className={`mt-1 min-h-11 rounded-sm text-brand-meta font-semibold text-brand-ink underline underline-offset-4 ${focusRing}`}
                  >
                    {expanded ? t('readLess') : t('readMore')}
                  </button>
                )}
              </div>
            )}
            {(movie.director || movie.cast.length > 0) && (
              <dl className="space-y-1 text-brand-ui">
                {movie.director && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-semibold text-brand-ink">{t('director')}</dt>
                    <dd className="min-w-0 text-brand-ink-2">{movie.director}</dd>
                  </div>
                )}
                {movie.cast.length > 0 && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-semibold text-brand-ink">{t('cast')}</dt>
                    <dd className="min-w-0 text-brand-ink-2">{movie.cast.join(', ')}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
