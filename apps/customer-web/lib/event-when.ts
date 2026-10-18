import { venueZone } from '@eticketsgo/shared-types';

/**
 * A show's start with the venue's zone named, the way the Sessions list and the ticket print it.
 *
 * The event page's key facts printed "7:30 pm" and nothing else, while the Sessions row under it
 * said "7:30 pm (IST)". A buyer planning a trip from another zone read the first one. The zone
 * is only named when the venue has one: guessing would put the reader's own clock in its place.
 */
export function whenWithZone(
  startsAt: string,
  zone: string | undefined,
  format: {
    dateTime: (iso: string, locale?: string, zone?: string) => string;
    zoneAbbrev: (iso: string, zone?: string) => string;
  },
): string {
  const text = format.dateTime(startsAt, undefined, zone);
  return zone ? `${text} (${format.zoneAbbrev(startsAt, zone)})` : text;
}

/*
  ── WHOSE CLOCK A SHOW IS ON ─────────────────────────────────────────────────────────────
  Every show time a buyer reads is the time AT THE VENUE: the time on the ticket, on the
  confirmation and at the door. A missing zone used to fall silently to the reader's own clock.
  On QA, in a browser set to America/Denver, the event page showed a show as "Wed 28 Oct 2026,
  10:04 pm" while its confirmation showed "Thu 29 Oct 2026, 9:34 am GMT+5:30": the page read
  only the venue row's zone column, and the seat page read a summary whose zone was null.

  These answer the zone the same way the API answers it for the booking (`showTimezone`): the
  session's own zone when the API sends one (a cinema's screen is on the cinema's clock), else
  the venue's, else the only zone the venue's country has. `undefined` means truly unknown.
*/

type VenuePlace = { timezone?: string | null; country?: string | null };

/** The zone an event's times are printed in when no session says otherwise. */
export function eventZone(event: {
  timeZone?: string | null;
  venue: VenuePlace;
}): string | undefined {
  return (
    event.timeZone ??
    venueZone(event.venue.timezone ?? null, event.venue.country ?? null) ??
    undefined
  );
}

/** The zone ONE session is printed in: its own when the API says, else its event's. */
export function sessionZone(
  session: { timeZone?: string | null } | null | undefined,
  event: { timeZone?: string | null; venue: VenuePlace },
): string | undefined {
  return session?.timeZone ?? eventZone(event);
}

/**
 * The zone a seat page's show is on. The summary's own zone, else the venue country's only
 * zone: an older API answered null for a room in a venue that is not a cinema.
 */
export function summaryZone(summary: {
  timeZone?: string | null;
  venue: { country?: string | null };
}): string | undefined {
  return summary.timeZone ?? venueZone(null, summary.venue.country ?? null) ?? undefined;
}

/** The reader's own zone; undefined where Intl cannot say. */
export function readerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * A show's start in parts - "Thu 29 Oct 2026", "9:34 am", "GMT+5:30" - on the venue's clock.
 *
 * The zone is always named. When the venue's zone is truly unknown the time is the reader's
 * own and is named as theirs ("MDT"), never passed off unlabelled as the venue's.
 */
export function venueWhenParts(
  iso: string,
  zone: string | undefined,
  locale: string,
  zoneAbbrev: (iso: string, zone?: string) => string,
): { day: string; time: string; zone: string } {
  const at = new Date(iso);
  const shownZone = zone ?? readerTimeZone();
  const opts = shownZone ? { timeZone: shownZone } : {};
  let day: string;
  let time: string;
  try {
    day = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...opts,
    })
      .format(at)
      .replace(/,/g, '');
    time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...opts }).format(
      at,
    );
  } catch {
    day = at.toDateString();
    time = at.toTimeString().slice(0, 5);
  }
  return { day, time, zone: shownZone ? zoneAbbrev(iso, shownZone) : '' };
}
