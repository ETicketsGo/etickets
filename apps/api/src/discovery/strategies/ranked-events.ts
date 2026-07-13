import type { PublicEventsService } from '../../events/public-events.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { confirmedBookingCounts } from './booking-counts';
import { rankBySignals, type RankWeights } from './ranking';

/** The public event card shape returned by PublicEventsService.list. */
export type EventCard = Awaited<ReturnType<PublicEventsService['list']>>['data'][number];

/** How many candidates to score before taking the top slice. */
const CANDIDATE_POOL = 24;

/**
 * Fetch published events (reusing PublicEventsService.list — no new query),
 * attach confirmed-booking counts, rank with the given weights, and return the
 * top `limit`. Shared by Trending/Popular/Recommended.
 */
export async function rankedEventCards(
  prisma: PrismaService,
  publicEvents: PublicEventsService,
  ctx: { city?: string; now: Date },
  weights: RankWeights,
  limit: number,
): Promise<EventCard[]> {
  const { data } = await publicEvents.list({
    page: 1,
    pageSize: CANDIDATE_POOL,
    city: ctx.city,
  });
  const counts = await confirmedBookingCounts(
    prisma,
    data.map((e) => e.id),
  );
  const ranked = rankBySignals(
    data,
    (e) => ({ bookings: counts.get(e.id) ?? 0, nextSessionAt: e.nextSessionAt }),
    ctx.now,
    weights,
  );
  return ranked.slice(0, limit);
}
