import { HydrationBoundary } from '@tanstack/react-query';
import { scopeInputFromSeed } from '@eticketsgo/web-kit/server';
import { serverCitySeed } from '@/lib/city-seed';
import { prefetchPublic } from '@/lib/prefetch';
import {
  browseEventsQuery,
  browseRequest,
  emptyPlaceCitiesQuery,
  emptyPlaceCountry,
  categoriesQuery,
  initialBrowseFilters,
} from '@/lib/storefront-queries';
import { EventsPage } from './events-page';

/**
 * Browse, drawn with its first page of results.
 *
 * The list and the category options are read here for the visitor's place and the link's own
 * filters - the same request `EventsPage` makes, built by the same functions - so the first paint
 * is the list, not a skeleton that the "Showing events in ..." line then pushed down and a
 * momentary "No events available" replaced.
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
  const filters = initialBrowseFilters(params, place);
  const state = await prefetchPublic((client) =>
    Promise.allSettled([
      client.prefetchQuery(categoriesQuery()),
      seed.ready
        ? client.fetchQuery(browseEventsQuery(browseRequest(filters, place), 1)).then((list) => {
            // An empty place offers the cities in its country that have something on.
            const key = emptyPlaceCountry(place);
            if (list.data.length === 0 && !filters.q && !filters.category && key)
              return client.prefetchQuery(emptyPlaceCitiesQuery(key));
          })
        : undefined,
    ]),
  );
  return (
    <HydrationBoundary state={state}>
      <EventsPage />
    </HydrationBoundary>
  );
}
