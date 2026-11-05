import { HydrationBoundary } from '@tanstack/react-query';
import { countryKey, scopeInputFromSeed, selectedPlace } from '@eticketsgo/web-kit/server';
import { DiscoverHome } from '@/components/discover-home';
import { HOME_DESCRIPTION, HOME_TITLE, localizedMetadata } from '@/lib/seo';
import { serverCitySeed, serverRecentIds } from '@/lib/city-seed';
import { homeDetailSlugs } from '@/lib/home-feed';
import { prefetchPublic } from '@/lib/prefetch';
import {
  anywhereTotalQuery,
  categoriesQuery,
  eventQuery,
  homeEventsQuery,
  homeMoviesQuery,
  recentEventsQuery,
  sellableCitiesQuery,
} from '@/lib/storefront-queries';

/** The owner's title and description, exactly, and the page names itself as canonical. */
export const generateMetadata = localizedMetadata('/', {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
});

/**
 * The front door is a ticket shop.
 *
 * ── WHAT THIS REPLACED, AND WHY ────────────────────────────────────────────────────
 * This route used to serve a marketing landing to signed-out visitors and the discovery
 * experience only to signed-in ones. Every first-time buyer - which is every buyer, once -
 * arrived at a page headed "Sell tickets. Check in guests. Grow every event.", whose primary
 * action was "Start selling tickets" and which showed not one event, film, city or showtime.
 * The browser tab read "Sell tickets, check in guests, see your sales".
 *
 * The marketplace was already built and already good; it was behind a sign-in. The buyer
 * experience here is not new work - it is `DiscoverHome`, unchanged in substance, shown to
 * the people it was built for.
 *
 * Organizer acquisition keeps its own path at `/organizers`, and the full pitch lives at
 * `/sell`. Those are secondary journeys now, which is the correct order: somebody who runs
 * events will look for us; somebody who wants a ticket tonight will not.
 *
 * ── DRAWN FINISHED ─────────────────────────────────────────────────────────────────
 * The hero, the chips and the first section are read here, on the server, for the visitor's
 * place (`lib/city-seed.ts`), so the first paint is the finished front door - not a dark
 * placeholder for several seconds, "Coming up" re-titled "Coming up in India", and chips
 * sliding sideways as categories arrived. On a first visit the place is not known yet; the
 * page then waits for it behind the same placeholder rather than showing another country.
 */
export default async function HomePage() {
  const seed = await serverCitySeed();
  const recentIds = await serverRecentIds();
  const place = scopeInputFromSeed(seed);
  const state = await prefetchPublic(async (client) => {
    const categories = client.prefetchQuery(categoriesQuery());
    if (!seed.ready) return categories;
    const listing = client.fetchQuery(homeEventsQuery(place)).then(async (list) => {
      if (list.data.length === 0) {
        // The empty front door names cities that have something on, and whether anything does.
        await Promise.all([
          client.prefetchQuery(sellableCitiesQuery(countryKey(selectedPlace(place).country))),
          client.prefetchQuery(anywhereTotalQuery()),
        ]);
        return;
      }
      // Whether each featured listing can be bought decides the hero; ask before drawing it.
      await Promise.all(
        homeDetailSlugs(list.data).map((slug) =>
          client.prefetchQuery({ ...eventQuery(slug), staleTime: 60_000 }),
        ),
      );
    });
    // "Recently viewed", and whether each of its first cards can be bought.
    const recent =
      recentIds.length > 0
        ? client
            .fetchQuery(recentEventsQuery(recentIds))
            .then((list) =>
              Promise.all(
                list.data
                  .slice(0, 4)
                  .map((e) => client.prefetchQuery({ ...eventQuery(e.slug), staleTime: 60_000 })),
              ),
            )
        : undefined;
    return Promise.allSettled([
      categories,
      listing,
      recent,
      client.prefetchQuery(homeMoviesQuery(place)),
    ]);
  });
  return (
    <HydrationBoundary state={state}>
      <DiscoverHome recentIds={recentIds} />
    </HydrationBoundary>
  );
}
