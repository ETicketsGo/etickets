import { HydrationBoundary } from '@tanstack/react-query';
import { prefetchPublic } from '@/lib/prefetch';
import { showOffersQuery, showSeatsQuery, showSummaryQuery } from '@/lib/storefront-queries';
import { SeatSelectionPage } from './show-page';

/**
 * The seat page, drawn with its room.
 *
 * The seat map, the show's own header and its advertised offers are read here - the keys
 * `SeatSelectionPage` asks for - so the first paint is the map under its header. It used to be
 * a grey block the height of a map with the footer under it, and when the map arrived the
 * footer was pushed off the screen and the header appeared over the room: 0.22-0.28 of layout
 * shift on every visit.
 */
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const state = await prefetchPublic((client) =>
    Promise.allSettled([
      client.prefetchQuery(showSeatsQuery(sessionId, null)),
      client.prefetchQuery({ ...showSummaryQuery(sessionId), staleTime: 60_000 }),
      client.prefetchQuery({ ...showOffersQuery(sessionId), staleTime: 300_000 }),
    ]),
  );
  return (
    <HydrationBoundary state={state}>
      <SeatSelectionPage />
    </HydrationBoundary>
  );
}
