import { api as wk, cityScope, countryKey, type ScopeInput } from '@eticketsgo/web-kit/server';

/**
 * The storefront's public reads, each as ONE key and ONE fetch.
 *
 * ── WHY THEY LIVE HERE ─────────────────────────────────────────────────────────────
 * The server renders the first paint with these (`lib/prefetch.ts`) and hands the answers to
 * the browser, whose components ask for the same keys and find them already there. That only
 * works if both sides build the key identically: a key that differs by one field is a cache
 * miss, a skeleton, and the page jumping when the browser's own answer lands - the very thing
 * the server render was for. So no page spells a key itself; it asks for one of these.
 *
 * Plain functions over the kit's API client (no React, no browser globals), so a server
 * component and a client component can both import this file.
 */

/** Published categories with counts: the home chips and Browse's category list. */
export const categoriesQuery = () => ({
  queryKey: ['public-categories'] as const,
  queryFn: () => wk.publicCategories(),
});

/** Everything on in the visitor's place: the home hero and its first section. */
export const homeEventsQuery = (place: ScopeInput) => {
  const scope = cityScope(place);
  return {
    queryKey: ['events', 'home', JSON.stringify(scope)] as const,
    queryFn: () => wk.publicEvents.list({ pageSize: '24', ...scope }),
  };
};

/** "Now showing" on the home page: a chosen city, else the country, else everywhere. */
export const homeMoviesQuery = (place: ScopeInput) => ({
  queryKey: ['movies', 'home', JSON.stringify(cityScope(place))] as const,
  queryFn: () =>
    wk.publicMovies.list(
      place.city ? { city: place.city } : place.country ? { country: place.country } : undefined,
    ),
});

/** Cities with something on in a country: what an empty home page offers instead. */
export const sellableCitiesQuery = (country: string | null) => ({
  queryKey: ['public-sellable-cities', country] as const,
  queryFn: () => wk.location.cities({ country: country ?? undefined, limit: 8 }),
});

/**
 * The cities an empty Browse, Movies or Explore offers (`EmptyPlace`): those in the selected
 * place's country with something on. Keyed by that country's code.
 */
export const emptyPlaceCitiesQuery = (country: string | null) => ({
  queryKey: ['sellable-cities', country] as const,
  queryFn: () => wk.location.cities({ country: country ?? undefined, limit: 8 }),
});

/** The country `EmptyPlace` offers cities in: the chosen city's own, else the scope. */
export const emptyPlaceCountry = (place: ScopeInput) =>
  countryKey(place.place?.country ?? place.country);

/** Whether anything is on sale anywhere: the unscoped listing's total, one row long. */
export const anywhereTotalQuery = () => ({
  queryKey: ['events', 'home', 'anywhere-total'] as const,
  queryFn: () => wk.publicEvents.list({ pageSize: '1' }),
});

/** One event's public page (also how the home page learns whether a listing can be bought). */
export const eventQuery = (slug: string) => ({
  queryKey: ['event', slug] as const,
  queryFn: () => wk.publicEvents.get(slug),
});

export const reviewsQuery = (eventId: string | undefined) => ({
  queryKey: ['reviews', eventId] as const,
  queryFn: () => wk.reviews.forEvent(eventId!),
});

export const recommendationsQuery = (eventId: string | undefined) => ({
  queryKey: ['recommendations', eventId] as const,
  queryFn: () => wk.recommendations({ eventId: eventId!, limit: 4 }),
});

export const addOnsQuery = (eventId: string | undefined) => ({
  queryKey: ['public-addons', eventId] as const,
  queryFn: () => wk.commerce.publicAddOns(eventId!),
});

export const bundlesQuery = (eventId: string | undefined) => ({
  queryKey: ['public-bundles', eventId] as const,
  queryFn: () => wk.commerce.publicBundles(eventId!),
});

/** Recently viewed, re-read from the catalogue by id (`useRecentlyViewed`). */
export const recentEventsQuery = (ids: readonly string[]) => ({
  queryKey: ['events', 'by-id', ids.join(',')] as const,
  queryFn: () => wk.publicEvents.list({ ids: ids.join(','), pageSize: String(ids.length) }),
});

/** Browse's page size; "Load more" asks for the next page of the same size. */
export const BROWSE_PAGE_SIZE = 24;

/** What Browse sends: see `browseRequest`. */
export type BrowseRequest = Record<string, string | undefined>;

export const browseEventsQuery = (request: BrowseRequest, page: number) => ({
  queryKey: ['events', request, page] as const,
  queryFn: () =>
    wk.publicEvents.list({ pageSize: String(BROWSE_PAGE_SIZE), page: String(page), ...request }),
});

/**
 * What Browse is asking the API for: the filters the customer chose, plus the place.
 *
 * The country scope is applied to the REQUEST but is never one of the customer's filters: it is
 * what we inferred on their behalf, and a chip saying "India" would put words in their mouth.
 * A chosen city carries its own country and state, so a same-named city elsewhere is not mixed
 * in - but only when the city on the page IS the chosen one; a city typed into Browse's own box
 * carries no place, and must not inherit another city's.
 */
export function browseRequest(
  applied: {
    q?: string;
    city?: string;
    category?: string;
    dateFrom?: string;
    dateTo?: string;
    freeOnly?: boolean;
  },
  place: ScopeInput,
): BrowseRequest {
  const { freeOnly, ...rest } = applied;
  return {
    ...rest,
    ...(freeOnly ? { freeOnly: 'true' } : {}),
    ...(applied.city ? {} : place.country ? { country: place.country } : {}),
    ...(applied.city && applied.city === place.city && place.place?.country
      ? { cityCountry: place.place.country }
      : {}),
    ...(applied.city && applied.city === place.city && place.place?.region
      ? { region: place.place.region }
      : {}),
  };
}

/**
 * Where Browse starts: the link's own `?q=`, `?city=`, `?category=`, else the header's city.
 *
 * A link that says ?city= is the most specific intent there is, so it wins over the header: a
 * shared link to "events in Pune" opens in Pune for somebody whose header says Mumbai.
 */
export function initialBrowseFilters(
  params: { get(name: string): string | null },
  place: ScopeInput,
): { q?: string; city?: string; category?: string } {
  const city = params.get('city') || place.city || undefined;
  return {
    q: params.get('q') || undefined,
    city,
    category: params.get('category') || undefined,
  };
}

/** The film list: what the customer searched for, in their place. */
export const moviesListQuery = (applied: { q?: string; genre?: string }, place: ScopeInput) => {
  const scope = cityScope(place);
  return {
    queryKey: ['movies', applied, JSON.stringify(scope)] as const,
    queryFn: () => wk.publicMovies.list({ ...applied, ...scope }),
  };
};

/** Where the film list starts: the link's own `?q=` and `?genre=`. */
export function initialMovieFilters(params: { get(name: string): string | null }): {
  q?: string;
  genre?: string;
} {
  return { q: params.get('q') || undefined, genre: params.get('genre') || undefined };
}

/** Every film anywhere, only for the genre list (which must not shrink with the city). */
export const movieGenresQuery = () => ({
  queryKey: ['movies', 'genres'] as const,
  queryFn: () => wk.publicMovies.list({}),
});

/** Explore's two feeds, for the visitor's place. */
export const discoveryQuery = (place: ScopeInput) => {
  const scope = cityScope(place);
  return {
    queryKey: ['discovery', JSON.stringify(scope)] as const,
    queryFn: () => wk.discovery(scope),
  };
};

export const discoverySectionsQuery = (place: ScopeInput) => {
  const scope = cityScope(place);
  return {
    queryKey: ['discovery-sections', JSON.stringify(scope)] as const,
    queryFn: () => wk.discovery.sectionFeed(scope),
  };
};

/** A show's seats; `section` null is the whole room (a cinema) or the venue overview. */
export const showSeatsQuery = (sessionId: string, section: string | null) => ({
  queryKey: ['seats', sessionId, section] as const,
  queryFn: () => wk.publicShows.seats(sessionId, section ?? undefined),
});

/** Which show this is: film or event, venue, room and time. */
export const showSummaryQuery = (sessionId: string) => ({
  queryKey: ['show-summary', sessionId] as const,
  queryFn: () => wk.publicShows.summary(sessionId),
});

/** Offers the organizer chose to advertise for a show. */
export const showOffersQuery = (sessionId: string) => ({
  queryKey: ['offers', sessionId] as const,
  queryFn: () => wk.bookingQuote.offers(sessionId),
});
