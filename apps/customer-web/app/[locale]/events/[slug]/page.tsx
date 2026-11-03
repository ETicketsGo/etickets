import { HydrationBoundary } from '@tanstack/react-query';
import { prefetchPublic } from '@/lib/prefetch';
import {
  addOnsQuery,
  bundlesQuery,
  eventQuery,
  recommendationsQuery,
  reviewsQuery,
} from '@/lib/storefront-queries';
import { EventDetailPage } from './event-page';

/**
 * An event page, drawn with its event.
 *
 * The event and the reads its booking panel and lower sections make are fetched here - the
 * same keys `EventDetailPage` asks for - so the first paint is the event, not a blank stage for
 * as long as the browser took to start, fetch and render it (four seconds on a throttled phone).
 *
 * A fresh read, not the layout's hour-cached one: that one only names the page for search
 * engines, and seats and prices on screen must be current.
 */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = await prefetchPublic(async (client) => {
    const event = await client.fetchQuery(eventQuery(slug));
    await Promise.allSettled([
      client.prefetchQuery(addOnsQuery(event.id)),
      client.prefetchQuery(bundlesQuery(event.id)),
      client.prefetchQuery(reviewsQuery(event.id)),
      client.prefetchQuery(recommendationsQuery(event.id)),
    ]);
  });
  return (
    <HydrationBoundary state={state}>
      <EventDetailPage />
    </HydrationBoundary>
  );
}
