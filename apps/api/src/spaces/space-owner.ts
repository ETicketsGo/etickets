import { marketFor, unambiguousZoneFor } from '@eticketsgo/shared-types';

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
  /** Nullable because a venue may genuinely not have been asked. */
  venue?: { timezone: string | null } | null;
  cinema?: { timezone: string | null } | null;
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
 * -- WHY THE VENUE CAN BE TRUSTED HERE NOW -------------------------------------------------
 * It could not be, until `Venue.timezone` became nullable. While the column defaulted to
 * `Asia/Kolkata`, a venue that had never been ASKED for a zone still ANSWERED, and nothing
 * distinguished that guess from a venue genuinely in India. Preferring the venue therefore
 * shadowed a correct answer with a defaulted one, and did:
 *
 *   a Sydney cinema's 00:30 show was stored and reported as 06:00 - the exact IST offset -
 *   because its venue had never been given a zone and so claimed Asia/Kolkata.
 *
 * The column now has no default and may be null, so a value here means somebody supplied it.
 * That is what makes venue-first correct rather than merely tidy: `??` falls through on the
 * venues that were never asked and stops on the ones that were.
 *
 * The cinema remains the fallback, not a competitor. It holds a zone written at creation from
 * what the operator chose, which is the best answer available for a venue predating this.
 */
export function spaceTimezone(space: SpacePlacement): string | null {
  return space.venue?.timezone ?? space.cinema?.timezone ?? null;
}

/**
 * The zone `Cinema.timezone` holds when nobody chose one: the column's schema default.
 *
 * Exported so the resolver below and its tests name the same value. It is not a fallback and
 * must never be used as one.
 */
export const CINEMA_DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** What `showTimezone` needs selected. Spread `SHOW_ZONE_SCREEN_SELECT` to get it. */
export interface ShowZoneScreen {
  venue?: { timezone?: string | null; country?: string | null } | null;
  cinema?: { timezone?: string | null; country?: string | null } | null;
}

export interface ShowZoneVenue {
  timezone?: string | null;
  country?: string | null;
}

/**
 * The zone a SHOW's time is printed in for a buyer: "9:59 am MDT".
 *
 * ONE answer for the booking, the ticket, the guest booking view, the share card, the
 * reminder and change emails, and the storefront. Each of them used to write its own
 * `cinema?.timezone ?? venue` chain.
 *
 * -- ORDER ----------------------------------------------------------------------------------
 *   1. the space's venue zone, then the event's venue zone. The venue is where the show IS,
 *      and the organizer and admin consoles already treat it as the source of truth (#410);
 *   2. the cinema's zone, only when no venue has one and it was really chosen (see below);
 *   3. the one zone the country has (India, UK, UAE, Singapore);
 *   4. null. The caller then shows the reader's clock AND says so; it never guesses.
 *
 * -- THE DEFECT THIS EXISTS FOR -------------------------------------------------------------
 * The ticket chain read the cinema first. `Cinema.timezone` has a schema default of
 * Asia/Kolkata, so a US cinema created without a zone answered IST. On QA "Move Hall" sits in
 * a Boise venue (America/Boise) and its ticket and emails printed a 9:59 am show as
 * "10:29 pm GMT+5:30".
 *
 * -- WHY THE DEFAULT IS NOT TRUSTED OUTSIDE INDIA ---------------------------------------------
 * A stored Asia/Kolkata cannot tell "chosen" from "defaulted". Where the place's country is
 * known and is a market other than India, Asia/Kolkata can only be the default, so it is
 * treated as unset. Anywhere else the cinema's zone is kept: an Indian cinema, or a cinema
 * whose country nobody recorded, prints what it printed before.
 */
export function showTimezone(
  screen: ShowZoneScreen | null | undefined,
  eventVenue: ShowZoneVenue | null | undefined,
): string | null {
  const country =
    screen?.venue?.country?.trim() ||
    eventVenue?.country?.trim() ||
    screen?.cinema?.country?.trim();
  return (
    screen?.venue?.timezone?.trim() ||
    eventVenue?.timezone?.trim() ||
    chosenCinemaZone(screen?.cinema?.timezone, country) ||
    unambiguousZoneFor(country) ||
    null
  );
}

/** The cinema's zone, unless it is the schema default on a place known to be outside India. */
function chosenCinemaZone(
  zone: string | null | undefined,
  country: string | undefined,
): string | null {
  const z = zone?.trim();
  if (!z) return null;
  if (z === CINEMA_DEFAULT_TIMEZONE) {
    const market = marketFor(country);
    if (market && market.code !== 'IN') return null;
  }
  return z;
}

/**
 * The Prisma `select` on a `Screen` that `showTimezone` needs. Spread into the screen's select;
 * a caller that also needs other cinema or venue fields lists them next to these instead.
 */
export const SHOW_ZONE_SCREEN_SELECT = {
  venue: { select: { timezone: true, country: true } },
  cinema: { select: { timezone: true, country: true } },
} as const;

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
