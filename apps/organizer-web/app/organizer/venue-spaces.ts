import type { Venue, VenueSpace } from '@eticketsgo/web-kit';
import { currencyForCountry, effectiveSpaceKind, spaceKindOption } from '@eticketsgo/shared-types';

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
 * The kind the organizer chose when they made the space - "Hall or theatre", "Arena or
 * stadium" - and, for a cinema screen, which cinema it shows films for, because "Screen 4" in
 * a multiplex means something specific to the person running it. A space made before the kind
 * was asked is still just a space.
 */
export function spaceKindLabel(
  space: Pick<VenueSpace, 'kind' | 'cinemaId' | 'cinemaName'>,
): string {
  if (space.cinemaName) return `Cinema screen · ${space.cinemaName}`;
  return spaceKindOption(effectiveSpaceKind(space))?.label ?? 'Space';
}

/**
 * Where a space's own page is.
 *
 * ONE address for every space, cinema screen or not. The venues page linked every space to
 * `/organizer/cinemas/<space id>`, a route that takes a CINEMA id, so every link opened "We
 * couldn't load this"; after that a cinema screen lived under its cinema and every other space
 * under `/spaces`, so the same kind of thing had two kinds of page. The space page now shows
 * the cinema a screen belongs to, so nothing needs the cinema in the address.
 */
export function spaceHref(space: Pick<VenueSpace, 'id'>): string {
  return `/organizer/spaces/${space.id}`;
}

/** The configurations a space can be set up as, current version of each. */
export function spaceLayouts(space: VenueSpace) {
  return space.layouts ?? (space.layout ? [space.layout] : []);
}

/**
 * What a space can sell today, said plainly rather than as a status code.
 *
 * A space with SEVERAL layouts says how many, because that is the fact an operator of a real
 * arena needs on this page: the same room is a basketball bowl on Friday and an end-stage
 * concert on Saturday, and a page that named only one of them would be describing half their
 * building.
 */
export function spaceCapabilityLabel(space: VenueSpace): string {
  const layouts = spaceLayouts(space);
  if (layouts.length === 0 && space.kind === 'STANDING')
    return `General admission · holds ${space.capacity.toLocaleString()}`;
  if (layouts.length === 0) return 'No seat layout yet';
  if (layouts.length === 1) {
    const kind = layouts[0].layoutKind === 'SECTIONED' ? 'blocks' : 'a grid';
    return `Reserved seating · ${layouts[0].name ?? 'Layout'} (${kind})`;
  }
  return `${layouts.length} layouts`;
}

/**
 * The currency a space prices in, which is its VENUE's - with the symbol for a field label.
 *
 * Null when the venue has no country. Guessing would be the worse answer: a price box
 * labelled in rupees for a venue nobody placed is how a Warangal hall came to be priced in
 * dollars. Checkout refuses an unplaced venue anyway, so the page says what to fix instead.
 */
export function venueCurrency(
  country: string | null | undefined,
): { code: string; symbol: string } | null {
  const code = currencyForCountry(country);
  if (!code) return null;
  const symbol =
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? code;
  return { code, symbol };
}

/**
 * A typed price, in minor units - or what is wrong with it.
 *
 * The layout dialog's button used to stay DISABLED until a price box further down was filled,
 * with nothing saying why. Now the button always works and an empty or bad price is named.
 */
export function priceToMinor(text: string): { minor: number } | { problem: string } {
  const trimmed = text.trim();
  if (!trimmed) return { problem: 'Enter the price of the cheapest seat.' };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { problem: 'The price must be a number, 0 or more.' };
  return { minor: Math.round(n * 100) };
}
