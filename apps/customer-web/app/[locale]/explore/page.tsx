import { HydrationBoundary } from '@tanstack/react-query';
import { scopeInputFromSeed } from '@eticketsgo/web-kit/server';
import { serverCitySeed, serverRecentIds } from '@/lib/city-seed';
import { prefetchPublic } from '@/lib/prefetch';
import {
  discoveryQuery,
  discoverySectionsQuery,
  emptyPlaceCitiesQuery,
  emptyPlaceCountry,
  eventQuery,
  recentEventsQuery,
} from '@/lib/storefront-queries';
import { ExplorePage } from './explore-page';

/** How many listed events have their sale state read before the page is sent (`useBuyability`). */
const CHECKED = 36;

/**
 * Explore, drawn with its feeds.
 *
 * Both feeds for the visitor's place, and the sale state of the events they list (the price slot
 * on each card waits for it), are read here - the keys `ExplorePage` asks for - so the first
 * paint has the films, the events and their prices instead of placeholders that did not match
 * what replaced them.
 */
export default async function Page() {
  const seed = await serverCitySeed();
  const recentIds = await serverRecentIds();
  const place = scopeInputFromSeed(seed);
  const state = await prefetchPublic(async (client) => {
    if (!seed.ready) return;
    const [feed, sections, recent] = await Promise.all([
      client.fetchQuery(discoveryQuery(place)),
      client.fetchQuery(discoverySectionsQuery(place)),
      // The "Recently viewed" rail sits right under the heading: drawn now, not inserted later.
      recentIds.length > 0
        ? client.fetchQuery(recentEventsQuery(recentIds)).catch(() => null)
        : null,
    ]);
    const extra = sections.sections.filter((s) => s.key !== 'trending' && s.key !== 'weekend');
    const slugs = [
      ...(recent?.data ?? []).map((e) => e.slug),
      ...feed.trendingEvents.map((e) => e.slug),
      ...feed.thisWeekend.map((e) => e.slug),
      ...extra
        .filter((s) => s.kind === 'events')
        .flatMap((s) => (s.items as { slug: string }[]).map((e) => e.slug)),
    ];
    const empty =
      feed.nowShowing.length === 0 &&
      feed.trendingEvents.length === 0 &&
      feed.thisWeekend.length === 0 &&
      extra.length === 0;
    const key = emptyPlaceCountry(place);
    await Promise.allSettled([
      ...[...new Set(slugs)]
        .slice(0, CHECKED)
        .map((slug) => client.prefetchQuery({ ...eventQuery(slug), staleTime: 60_000 })),
      empty && key ? client.prefetchQuery(emptyPlaceCitiesQuery(key)) : undefined,
    ]);
  });
  return (
    <HydrationBoundary state={state}>
      <ExplorePage recentIds={recentIds} />
    </HydrationBoundary>
  );
}
