import { useQuery } from '@tanstack/react-query';
import { getParsed } from '@/services/http';
import { publicMovieSchema, publicShowsResponseSchema } from './movie-schema';

export const movieKeys = {
  all: ['movie'] as const,
  detail: (slug: string) => [...movieKeys.all, slug] as const,
  shows: (slug: string, city?: string) => [...movieKeys.all, slug, 'shows', city ?? ''] as const,
};

export function useMovie(slug: string) {
  return useQuery({
    queryKey: movieKeys.detail(slug),
    queryFn: () => getParsed(`/public/movies/${encodeURIComponent(slug)}`, publicMovieSchema),
    enabled: Boolean(slug),
    // Catalogue metadata changes rarely; a film's certificate does not move.
    staleTime: 30 * 60_000,
  });
}

/**
 * Screenings of a film.
 *
 * Short staleness because `availability` is live inventory — a SOLD_OUT badge that is
 * five minutes stale sends someone to a seat map with nothing on it.
 */
export function useMovieShows(slug: string, city?: string) {
  return useQuery({
    queryKey: movieKeys.shows(slug, city),
    queryFn: () =>
      getParsed(`/public/movies/${encodeURIComponent(slug)}/shows`, publicShowsResponseSchema, {
        ...(city ? { city } : {}),
      }),
    enabled: Boolean(slug),
    staleTime: 30_000,
  });
}
