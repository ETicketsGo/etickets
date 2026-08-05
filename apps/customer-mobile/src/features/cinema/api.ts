import { useQuery } from '@tanstack/react-query';
import { getParsed } from '@/services/http';
import { seatMapSchema, type Seat, type SeatMap } from './schema';

export const cinemaKeys = {
  all: ['cinema'] as const,
  seats: (sessionId: string) => [...cinemaKeys.all, 'seats', sessionId] as const,
};

/**
 * The seat map for a session.
 *
 * `staleTime: 0` and a refetch on focus, because this is live inventory shared with
 * every other person looking at the same screening. A cached seat map is a picture of
 * who had booked what a minute ago, and a minute is long enough for the seat someone is
 * about to tap to have gone.
 */
export function useSeatMap(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: cinemaKeys.seats(sessionId),
    queryFn: () => getParsed(`/public/shows/${encodeURIComponent(sessionId)}/seats`, seatMapSchema),
    enabled: enabled && Boolean(sessionId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

/** Every seat in the map, flattened, each carrying its row label. */
export function flattenSeats(
  map: SeatMap,
): { rowLabel: string; sectionName: string; seat: Seat }[] {
  return map.sections.flatMap((section) =>
    section.rows.flatMap((row) =>
      row.seats.map((seat) => ({ rowLabel: row.label, sectionName: section.name, seat })),
    ),
  );
}

export interface SeatConflict {
  seatId: string;
  name: string;
  /** What the server now says about it. */
  status: string;
}

/**
 * Re-check a selection against a freshly fetched map.
 *
 * Called immediately before creating the booking. Between selecting a seat and pressing
 * Continue the user may have spent minutes on the screen, and the API will reject the
 * whole booking if any one seat has gone — this turns that all-or-nothing rejection into
 * a specific, recoverable "B7 and B8 were taken" that names the seats to re-pick.
 *
 * A seat that has vanished from the map entirely (re-seated screen, pulled from sale) is
 * reported as a conflict too, not silently dropped.
 */
export function findSeatConflicts(fresh: SeatMap, selectedSeatIds: string[]): SeatConflict[] {
  const byId = new Map(flattenSeats(fresh).map((s) => [s.seat.id, s]));
  const conflicts: SeatConflict[] = [];

  for (const id of selectedSeatIds) {
    const found = byId.get(id);
    if (!found) {
      conflicts.push({ seatId: id, name: 'A selected seat', status: 'REMOVED' });
      continue;
    }
    if (found.seat.status !== 'AVAILABLE') {
      conflicts.push({
        seatId: id,
        name: `${found.rowLabel}${found.seat.label}`,
        status: found.seat.status,
      });
    }
  }
  return conflicts;
}

/**
 * Group selected seats into booking lines, one per ticket type.
 *
 * The API's booking item is `{ ticketTypeId, quantity, seatIds }` with the invariant
 * seatIds.length === quantity, enforced by createBookingSchema. Seats from different
 * price categories map to different ticket types, so a mixed selection is several lines.
 */
export function toBookingItems(
  map: SeatMap,
  selectedSeatIds: string[],
): { ticketTypeId: string; quantity: number; seatIds: string[] }[] {
  const categoryBySeat = new Map(flattenSeats(map).map((s) => [s.seat.id, s.seat.categoryId]));
  const ticketTypeByCategory = new Map(map.categories.map((c) => [c.id, c.ticketTypeId]));
  const lines = new Map<string, string[]>();

  for (const seatId of selectedSeatIds) {
    const categoryId = categoryBySeat.get(seatId);
    const ticketTypeId = categoryId ? ticketTypeByCategory.get(categoryId) : null;
    // A seat whose category has no ticket type cannot be booked; isSelectable() stops
    // it being picked, so reaching here means the map changed underneath us.
    if (!ticketTypeId) continue;
    lines.set(ticketTypeId, [...(lines.get(ticketTypeId) ?? []), seatId]);
  }

  return [...lines.entries()].map(([ticketTypeId, seatIds]) => ({
    ticketTypeId,
    quantity: seatIds.length,
    seatIds,
  }));
}

/** Total for a selection, in minor units, from the server's per-category prices. */
export function selectionTotalMinor(map: SeatMap, selectedSeatIds: string[]): number {
  const categoryBySeat = new Map(flattenSeats(map).map((s) => [s.seat.id, s.seat.categoryId]));
  const priceByCategory = new Map(map.categories.map((c) => [c.id, c.priceMinor]));
  return selectedSeatIds.reduce((sum, id) => {
    const categoryId = categoryBySeat.get(id);
    return sum + (categoryId ? (priceByCategory.get(categoryId) ?? 0) : 0);
  }, 0);
}

/**
 * How many seats one order may contain.
 *
 * The API enforces maxPerOrder per ticket type; a mixed-category selection is capped by
 * the smallest of them, because the client cannot know in advance how the user will
 * spread their picks across categories. Falls back to 10, the seeded value, only when
 * no session ticket types were supplied.
 */
export function maxSelectableSeats(maxPerOrderByTicketType: number[]): number {
  if (maxPerOrderByTicketType.length === 0) return 10;
  return Math.max(1, Math.min(...maxPerOrderByTicketType));
}
