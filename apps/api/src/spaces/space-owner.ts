/**
 * Who owns a space, where it is, and what it is called - asked in ONE place.
 *
 * -- WHY THIS EXISTS ----------------------------------------------------------------------
 * A space (`Screen`) used to reach all three of those through its cinema, because `cinemaId`
 * was required. Nine authorization checks read `screen.cinema.organizationId`, three timezone
 * reads read `screen.cinema.timezone`, and the event wizard labelled a space's VENUE with its
 * CINEMA's name.
 *
 * Now a space has its own venue and the cinema is optional, so every one of those reads has
 * two possible sources. Spreading `venue?.x ?? cinema?.x` across nine call sites is how the
 * two drift apart again - which is the defect this whole migration exists to remove - so the
 * precedence is written down once, here, and the call sites ask.
 *
 * -- PRECEDENCE ---------------------------------------------------------------------------
 * The VENUE wins. It is the authority for where a space is and who owns it. The cinema is
 * consulted only while a row has not been backfilled yet, which the migration makes
 * impossible for new rows and fixes for old ones; it is kept because a rolling deploy can
 * briefly serve a row written by an older instance.
 *
 * The one exception is a space with NEITHER, which cannot be authorized or placed. That is a
 * broken row rather than a case to guess at, so the callers that must have an answer get a
 * thrown error instead of a fallback.
 */

/** The least a caller must select for these to be answerable. */
export interface SpaceOwnership {
  venue?: { organizationId: string } | null;
  cinema?: { organizationId: string } | null;
}

export interface SpacePlacement {
  venue?: { timezone: string } | null;
  cinema?: { timezone: string } | null;
}

export interface SpaceNaming {
  venue?: { name: string } | null;
  cinema?: { name: string } | null;
}

/**
 * The organization that owns a space.
 *
 * `null` rather than a throw, so an authorization check can decide for itself: a caller
 * comparing it to an expected id must treat `null` as "not yours", and a caller asserting
 * membership should refuse. Returning a plausible-looking id here would turn a broken row
 * into a silent cross-tenant read, which is the worst outcome available.
 */
export function spaceOrganizationId(space: SpaceOwnership): string | null {
  return space.venue?.organizationId ?? space.cinema?.organizationId ?? null;
}

/**
 * The same, for callers that cannot continue without one.
 *
 * Throws rather than returning a default. There is no safe default for "which tenant does
 * this belong to".
 */
export function requireSpaceOrganizationId(space: SpaceOwnership): string {
  const id = spaceOrganizationId(space);
  if (!id) {
    throw new Error('This space belongs to no venue and no cinema, so it has no owner.');
  }
  return id;
}

/**
 * The zone a space's local dates and times are reckoned in.
 *
 * Every showtime, booking window, ticket face and reminder for this space is rendered in it,
 * so an absent answer is returned as `null` and never silently replaced with the launch
 * market's zone. A hardcoded zone has already produced two real defects on this track.
 *
 * -- WHY THE CINEMA WINS HERE, AND ONLY HERE ----------------------------------------------
 * Ownership and the name of the place come from the VENUE, because a venue either has an
 * organization and a name or it does not. Timezone is different: `Venue.timezone` is NOT NULL
 * with a default of `Asia/Kolkata`. So a venue that was never ASKED for a timezone returns
 * the launch market's, and nothing distinguishes that from a venue genuinely in India.
 *
 * Preferring the venue therefore shadows a correct answer with a defaulted one. It did:
 *
 *   a Sydney cinema's 00:30 show was stored and reported as 06:00 - the exact IST offset -
 *   because its venue had never been given a zone and so claimed Asia/Kolkata.
 *
 * `Cinema.timezone` has the same default, but it is WRITTEN at creation from what the
 * operator actually chose, so it carries a real answer where the venue carries a guess.
 *
 * This is the one place the venue is not authoritative, and it stays that way until
 * `Venue.timezone` can say "not set" - which means making it nullable and backfilling it from
 * the cinema. Until then, inverting this is a correctness bug, not a tidy-up.
 */
export function spaceTimezone(space: SpacePlacement): string | null {
  return space.cinema?.timezone ?? space.venue?.timezone ?? null;
}

/** What to call the place this space is in. The venue is the place; a cinema is a tenant of one. */
export function spaceVenueName(space: SpaceNaming): string | null {
  return space.venue?.name ?? space.cinema?.name ?? null;
}

/**
 * The Prisma `select` these answers need, so a caller cannot accidentally ask the question
 * without having fetched what answers it. Spread into an existing `select`.
 */
export const SPACE_OWNER_SELECT = {
  venue: { select: { id: true, organizationId: true, name: true, timezone: true } },
  cinema: { select: { id: true, organizationId: true, name: true, timezone: true } },
} as const;
