import { BookingStatus } from '@eticketsgo/shared-types';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Confirmed-booking count per event, for a set of event ids. Uses a Prisma
 * groupBy (no raw SQL) and returns a map defaulting missing events to 0.
 * Shared by Trending/Popular/Recommended so the popularity signal is computed
 * one way only.
 */
export async function confirmedBookingCounts(
  prisma: PrismaService,
  eventIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(eventIds.map((id) => [id, 0]));
  if (eventIds.length === 0) return counts;
  const rows = await prisma.booking.groupBy({
    by: ['eventId'],
    where: { eventId: { in: eventIds }, status: BookingStatus.CONFIRMED },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.eventId, row._count._all);
  return counts;
}
