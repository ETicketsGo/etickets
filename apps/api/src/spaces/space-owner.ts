import { venueZone } from '@eticketsgo/shared-types';

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
 * The zone a SHOW's time is printed in for a buyer: "7:00 pm GMT+5:30".
 *
 * The cinema's zone when the show is in a cinema's screen, else the event's venue's, else the
 * one zone the venue's country has. This is the order the booking, the ticket, the guest
 * booking view, the share card and the reminders already use, written down once so the
 * storefront's event page and seat page ask the same question and get the same answer.
 *
 * -- THE DEFECT THIS EXISTS FOR -------------------------------------------------------------
 * On QA, in a browser set to America/Denver, the event page showed a show as "Wed 28 Oct 2026,
 * 10:04 pm" while its booking confirmation showed "Thu 29 Oct 2026, 9:34 am GMT+5:30". The
 * event page read only `event.venue.timezone`; the confirmation read this chain. The seat
 * page's summary read `spaceTimezone` over a screen selected without its venue, so a room in a
 * venue (no cinema) had no zone at all and the header fell to the reader's clock.
 *
 * Not `spaceTimezone`: that one answers where a space IS, for scheduling. A show's printed time
 * must agree with the ticket the buyer already holds, and changing the ticket's order would be
 * a booking-path change this does not make.
 */
export function showTimezone(
  screen: { cinema?: { timezone: string | null } | null } | null | undefined,
  eventVenue: { timezone: string | null; country?: string | null } | null | undefined,
): string | null {
  return screen?.cinema?.timezone ?? venueZone(eventVenue?.timezone, eventVenue?.country);
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
