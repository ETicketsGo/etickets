import { HydrationBoundary } from '@tanstack/react-query';
import { scopeInputFromSeed } from '@eticketsgo/web-kit/server';
import { serverCitySeed } from '@/lib/city-seed';
import { prefetchPublic } from '@/lib/prefetch';
import {
  emptyPlaceCitiesQuery,
  emptyPlaceCountry,
  initialMovieFilters,
  movieGenresQuery,
  moviesListQuery,
} from '@/lib/storefront-queries';
import { MoviesPage } from './movies-page';

/**
 * Movies, drawn with its films (or with its honest empty state and the cities it offers).
 *
 * The same reads `MoviesPage` makes, for the visitor's place and the link's own filters, so the
 * first paint is the finished list: not eight poster placeholders that collapsed into "No films
 * in ..." and then grew a row of city chips under it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = {
    get: (name: string) => {
      const v = raw[name];
      return (Array.isArray(v) ? v[0] : v) ?? null;
    },
  };
  const seed = await serverCitySeed();
  const place = scopeInputFromSeed(seed);
  const filters = initialMovieFilters(params);
  const state = await prefetchPublic((client) =>
    Promise.allSettled([
      client.prefetchQuery(movieGenresQuery()),
      seed.ready
        ? client.fetchQuery(moviesListQuery(filters, place)).then((films) => {
            const key = emptyPlaceCountry(place);
            if (films.length === 0 && !filters.q && !filters.genre && key)
              return client.prefetchQuery(emptyPlaceCitiesQuery(key));
          })
        : undefined,
    ]),
  );
  return (
    <HydrationBoundary state={state}>
      <MoviesPage />
    </HydrationBoundary>
  );
}
