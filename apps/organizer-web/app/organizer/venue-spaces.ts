import type { Venue, VenueSpace } from '@eticketsgo/web-kit';

/**
 * The canonical hierarchy, assembled for the console:
 *
 *     VENUE -> SPACE -> LAYOUT
 *
 * -- WHY THIS REPLACES `venue-rooms.ts` ---------------------------------------------------
 * That grouped CINEMAS under venues, because a cinema was the only thing a venue could
 * contain. A bookable area now hangs off the venue directly, so the thing to show inside a
 * venue is its SPACES - and being a cinema is one fact about a space, not the space itself.
 *
 * The old file's load-bearing clause survives here for the same reason it existed: a space
 * the organizer can see in their own data must never vanish from the only page that lists
 * them. The difference is that a space with no venue is now an anomaly rather than the norm.
 */

export interface VenueWithSpaces {
  venue: Venue;
  /** Empty is normal. A lawn, a terrace or a ground sells fine without a drawn space. */
  spaces: VenueSpace[];
  /** How many of them can sell a numbered seat, i.e. have a published layout. */
  seatedCount: number;
}

export interface GroupedVenues {
  venues: VenueWithSpaces[];
  /**
   * Spaces belonging to no venue this organization can see.
   *
   * After the migration every space has a venue, so this should be empty - which is exactly
   * why it is shown rather than dropped. A non-empty list is evidence of a real problem, and
   * silently hiding it would turn that evidence into a mystery.
   */
  orphans: VenueSpace[];
}

export function groupSpacesByVenue(
  venues: readonly Venue[],
  spaces: readonly VenueSpace[],
): GroupedVenues {
  const byVenue = new Map<string, VenueSpace[]>();
  const known = new Set(venues.map((v) => v.id));
  const orphans: VenueSpace[] = [];

  for (const space of spaces) {
    const id = space.venueId;
    // A venue id this organization cannot see is as good as none: showing the space under a
    // venue that is not in the list would invent a parent for it.
    if (!id || !known.has(id)) {
      orphans.push(space);
      continue;
    }
    const list = byVenue.get(id);
    if (list) list.push(space);
    else byVenue.set(id, [space]);
  }

  return {
    venues: venues.map((venue) => {
      const inside = byVenue.get(venue.id) ?? [];
      return {
        venue,
        spaces: inside,
        seatedCount: inside.filter((s) => s.layout).length,
      };
    }),
    orphans,
  };
}

/**
 * What to call a space's kind, for somebody scanning a list.
 *
 * A cinema screen says so, because "Screen 4" in a multiplex means something specific to the
 * person running it. Everything else is just a space - the platform does not need to know
 * whether a hall is an auditorium or an arena in order to sell seats in it.
 */
export function spaceKindLabel(space: VenueSpace): string {
  if (space.cinemaName) return `Cinema screen · ${space.cinemaName}`;
  return 'Space';
}

/** What a space can sell today, said plainly rather than as a status code. */
export function spaceCapabilityLabel(space: VenueSpace): string {
  if (!space.layout) return 'No seating plan yet — sells general admission only';
  const kind = space.layout.layoutKind === 'SECTIONED' ? 'blocks' : 'a grid';
  return `Reserved seating · ${space.layout.name ?? 'Layout'} (${kind})`;
}
