'use client';

import { useState } from 'react';
import { Clock, Film, Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { gradientFor, hasRating } from '@eticketsgo/web-kit';
import type { PublicMovieCard } from '@/lib/api';
import { Badge } from './ui';
import { Link } from '@/i18n/navigation';
import { useRatingText } from './reviews/use-rating-text';

export function MovieCard({ movie }: { movie: PublicMovieCard }) {
  const t = useTranslations('showtimes');
  const words = useRatingText();
  const rating = hasRating(movie.rating) ? movie.rating : null;
  // A poster that does not load shows the placeholder, as the film page's hero does.
  const [posterFailed, setPosterFailed] = useState(false);

  return (
    <Link
      href={`/movies/${movie.slug}`}
      className="group block overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm transition-all duration-300 ease-premium hover:-translate-y-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-background-subtle">
        {movie.posterUrl && !posterFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={movie.posterUrl}
            alt={t('movie.poster', { title: movie.title })}
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 ease-premium group-hover:scale-105"
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${gradientFor(movie.id)}`}
          >
            <Film className="h-10 w-10 text-text-primary/25" aria-hidden />
          </div>
        )}
        {movie.certificate && (
          <div className="absolute left-3 top-3">
            <Badge tone="neutral">{movie.certificate}</Badge>
          </div>
        )}
        {rating && (
          /*
            A solid black band, not a gradient or a wash. A poster can be any colour, and a
            translucent strip takes its contrast from whatever the artwork happens to be under
            it — white on black is 21:1 on every poster. It is plain text inside the card's one
            link, never a control of its own.
          */
          <p className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black px-3 py-1.5 text-caption text-white">
            <span className="sr-only">{words.summary(rating)}</span>
            <span aria-hidden className="flex items-center gap-1 font-semibold tabular-nums">
              <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
              {words.outOf5(rating.average)}
            </span>
            <span aria-hidden className="truncate tabular-nums text-white/80">
              {words.votes(rating.count)}
            </span>
          </p>
        )}
      </div>

      <div className="space-y-2 p-4">
        <h3 className="line-clamp-1 text-title font-semibold text-text-primary transition-colors group-hover:text-action-primary">
          {movie.title}
        </h3>
        <p className="line-clamp-1 text-caption text-text-muted">
          {movie.language}
          {movie.genres.length > 0 ? ` - ${movie.genres.join(', ')}` : ''}
        </p>
        <p className="flex items-center gap-1.5 text-caption text-text-muted">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('card.runtime', { minutes: movie.runtimeMinutes })}
        </p>
      </div>
    </Link>
  );
}
