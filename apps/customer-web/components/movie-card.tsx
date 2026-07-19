'use client';

import Link from 'next/link';
import { Clock, Film } from 'lucide-react';
import { gradientFor } from '@eticketsgo/web-kit';
import type { PublicMovieCard } from '@/lib/api';
import { Badge } from './ui';

export function MovieCard({ movie }: { movie: PublicMovieCard }) {
  return (
    <Link
      href={`/movies/${movie.slug}`}
      className="group block overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm transition-all duration-300 ease-premium hover:-translate-y-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-background-subtle">
        {movie.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={movie.posterUrl}
            alt={`${movie.title} poster`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 ease-premium group-hover:scale-105"
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${gradientFor(movie.id)}`}
          >
            <Film className="h-10 w-10 text-text-primary/25" />
          </div>
        )}
        {movie.certificate && (
          <div className="absolute left-3 top-3">
            <Badge tone="neutral">{movie.certificate}</Badge>
          </div>
        )}
      </div>

      <div className="space-y-2 p-4">
        <h3 className="line-clamp-1 text-title font-semibold text-text-primary transition-colors group-hover:text-action-primary">
          {movie.title}
        </h3>
        <p className="line-clamp-1 text-caption text-text-muted">
          {movie.language}
          {movie.genres.length > 0 ? ` · ${movie.genres.join(', ')}` : ''}
        </p>
        <p className="flex items-center gap-1.5 text-caption text-text-muted">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {movie.runtimeMinutes} min
        </p>
      </div>
    </Link>
  );
}
