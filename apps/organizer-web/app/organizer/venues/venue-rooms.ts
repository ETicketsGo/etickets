import type { Cinema, Venue } from '@eticketsgo/web-kit';

/**
 * Putting rooms under the venue they belong to.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A `useMemo` IN THE PAGE ─────────────────────────
 * The rule it encodes is not obvious and one clause of it is load-bearing: a room whose
 * `venueId` is null must still be shown. Rooms predate the column, and a room the organizer
 * can see in their own data disappearing from the only page that lists rooms would be a
 * worse bug than the two-sections problem this page exists to fix.
 *
 * That is a claim worth a test, and a `useMemo` inside a client component is not reachable
 * from one.
 */

export interface VenueWithRooms {
  venue: Venue;
  /** Rooms inside this venue. Empty is normal — a lawn or a terrace has none. */
  rooms: Cinema[];
}

export interface GroupedPlaces {
  venues: VenueWithRooms[];
  /**
   * Rooms belonging to no venue, or to a venue this organization cannot see.
   *
   * Kept separate rather than dropped or lumped under an arbitrary venue: they work, their
   * events sell, and hiding them would make the page lie about what exists.
   */
  orphans: Cinema[];
}

export function groupRoomsByVenue(
  venues: readonly Venue[],
  rooms: readonly Cinema[],
): GroupedPlaces {
  const byVenue = new Map<string, Cinema[]>();
  const known = new Set(venues.map((v) => v.id));
  const orphans: Cinema[] = [];

  for (const room of rooms) {
    /*
      The second half of this condition matters as much as the first. A room can name a venue
      that is not in the list — a stale reference, or a venue outside what this response
      returned — and grouping on the id alone would file it under a key nothing renders, so it
      would vanish silently. Unknown is treated exactly like absent.
    */
    if (!room.venueId || !known.has(room.venueId)) {
      orphans.push(room);
      continue;
    }
    const list = byVenue.get(room.venueId);
    if (list) list.push(room);
    else byVenue.set(room.venueId, [room]);
  }

  return {
    // Venue order is the server's. Re-sorting here would fight whatever it decided.
    venues: venues.map((venue) => ({ venue, rooms: byVenue.get(venue.id) ?? [] })),
    orphans,
  };
}

/** How many screens a room has, which is what decides whether it can sell a numbered seat. */
export function screenCount(room: Cinema): number {
  return room.screens?.length ?? 0;
}
