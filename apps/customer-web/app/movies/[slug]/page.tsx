'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Clock, Film, MapPin, Clapperboard, Users } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { Badge, Card, EmptyState, ErrorState } from '@/components/ui';

function showtime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function showDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export default function MovieDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const {
    data: movie,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['movie', slug],
    queryFn: () => api.getMovie(slug),
  });

  if (isLoading) return <div className="h-96 animate-pulse rounded-lg bg-background-subtle" />;
  if (isError) {
    const notFound = error instanceof ApiRequestError && error.code === 'NOT_FOUND';
    return notFound ? (
      <EmptyState title="Movie not found" hint="This film may no longer be listed." icon={Film} />
    ) : (
      <ErrorState
        message="We couldn't load this movie. Please try again."
        onRetry={() => refetch()}
      />
    );
  }
  if (!movie)
    return (
      <EmptyState title="Movie not found" hint="This film may no longer be listed." icon={Film} />
    );

  const meta = [
    { label: 'Runtime', value: `${movie.runtimeMinutes} min`, icon: Clock },
    movie.director ? { label: 'Director', value: movie.director, icon: Clapperboard } : null,
  ].filter(Boolean) as { label: string; value: string; icon: typeof Clock }[];

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="grid gap-6 sm:grid-cols-[220px_1fr]">
        <div className="mx-auto w-40 overflow-hidden rounded-lg border border-border bg-background-subtle shadow-sm sm:mx-0 sm:w-full">
          <div className="aspect-[2/3] w-full">
            {movie.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={movie.posterUrl}
                alt={`${movie.title} poster`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Film className="h-10 w-10 text-text-primary/25" />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {movie.certificate && <Badge tone="neutral">{movie.certificate}</Badge>}
              <Badge tone="info">{movie.language}</Badge>
            </div>
            <h1 className="mt-3 text-h2 font-bold tracking-tight text-text-primary sm:text-h1">
              {movie.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.9375rem] text-text-secondary">
              {meta.map((m) => (
                <span key={m.label} className="flex items-center gap-1.5">
                  <m.icon className="h-4 w-4 text-text-muted" />
                  {m.value}
                </span>
              ))}
            </div>
          </div>

          {movie.genres.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {movie.genres.map((g) => (
                <Badge key={g} tone="neutral">
                  {g}
                </Badge>
              ))}
            </div>
          )}

          {movie.synopsis && (
            <p className="whitespace-pre-line leading-relaxed text-text-secondary">
              {movie.synopsis}
            </p>
          )}

          {movie.cast.length > 0 && (
            <p className="flex items-start gap-2 text-[0.9375rem] text-text-muted">
              <Users className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{movie.cast.join(', ')}</span>
            </p>
          )}
        </div>
      </div>

      {/* Showtimes */}
      <div>
        <h2 className="text-title font-semibold text-text-primary">Showtimes</h2>
        {movie.shows.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No shows scheduled"
              hint="Check back soon — showtimes for this film aren't available yet."
              icon={Clock}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {movie.shows.map((show) => (
              <Card key={show.eventId}>
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-action-primary" />
                  <h3 className="font-semibold text-text-primary">{show.cinemaName ?? 'Cinema'}</h3>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {show.sessions.map((s) => (
                    <Link
                      key={s.id}
                      href={`/shows/${s.id}`}
                      className="flex flex-col items-center rounded-md border border-border px-4 py-2 text-center transition-all hover:border-action-primary hover:bg-action-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label={`Book ${showtime(s.startsAt)} on ${showDay(s.startsAt)}${s.screenName ? `, ${s.screenName}` : ''}`}
                    >
                      <span className="text-[0.9375rem] font-medium text-text-primary">
                        {showtime(s.startsAt)}
                      </span>
                      <span className="text-caption text-text-muted">
                        {showDay(s.startsAt)}
                        {s.screenName ? ` · ${s.screenName}` : ''}
                      </span>
                    </Link>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
