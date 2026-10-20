import { readerTimeZone } from './event-when';

/*
  ── THE EVENT PAGE'S EDITORIAL FACTS ──────────────────────────────────────────────────
  The owner's event-page design (2026-10-19) opens with a gold line - "MUSIC . BOISE . THURSDAY
  5 NOVEMBER" - and a ruled row of DATE / TIME / VENUE, then "Before you arrive". Every one of
  those is a claim about the event, so each is worked out here, from the event's own data, and
  tested; the page only lays them out.

  The rule the owner set: a fact shows ONLY when it is true for this event. No "Doors" without a
  doors time, no "Refundable until" without a refund window, no "Arrival & parking" the
  organizer never wrote.
*/

/** A show's date in the venue's clock, written out: "Thursday", "5 November 2026". */
export interface LongVenueDate {
  /** "Thursday" */
  weekday: string;
  /** "5 November 2026" */
  date: string;
  /** "Thursday 5 November" - the eyebrow over the title, without the year. */
  short: string;
  /** 0-23 at the venue, for the one heading that depends on it ("The evening"). */
  hour: number;
}

export function longVenueDate(
  iso: string,
  zone: string | undefined,
  locale: string,
): LongVenueDate {
  const at = new Date(iso);
  const shownZone = zone ?? readerTimeZone();
  const opts = shownZone ? { timeZone: shownZone } : {};
  try {
    const part = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, { ...options, ...opts }).format(at).replace(/,/g, '');
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', ...opts }).format(at),
    );
    return {
      weekday: part({ weekday: 'long' }),
      date: part({ day: 'numeric', month: 'long', year: 'numeric' }),
      short: part({ weekday: 'long', day: 'numeric', month: 'long' }),
      hour: Number.isFinite(hour) ? hour : at.getHours(),
    };
  } catch {
    return {
      weekday: '',
      date: at.toDateString(),
      short: at.toDateString(),
      hour: at.getHours(),
    };
  }
}

/**
 * Whether "The evening" is a true name for this show: it starts at 5 pm or later at the venue.
 *
 * The design calls the description "The evening". A coffee workshop at 10:30 in the morning is
 * not an evening, and a heading that says so is the page telling the buyer something false; a
 * daytime event keeps the plain "About this event".
 */
export function isEveningShow(hour: number): boolean {
  return hour >= 17;
}

/** The facts "Before you arrive" may list. Each is either true for the event or absent. */
export type ArrivalFact = 'offline' | 'transfer';

/**
 * The "Before you arrive" facts that hold for this event, in the design's order.
 *
 * - offline: every ticket in My tickets is kept on the phone and scans without a signal
 *   (lib/offline). True of every event the platform sells, so always listed when the event
 *   has a date to arrive at.
 * - transfer: an ACTIVE ticket of an account booking can be transferred from the booking's
 *   tickets page (sharing service, TRANSFER permission). No event switches this off. The copy
 *   says a guest booking cannot, which is the API's rule.
 *
 * Not listed, for want of data the public event does not carry (2026-10-19):
 * - "Refundable until <date>": the event's refund window (refundsEnabled, refundCutoffHours)
 *   is not in the public event response, and the refund policy is free text.
 * - "Doors": no session has a doors time.
 * - "Arrival & parking": there is no field for it.
 */
export function arrivalFacts(hasUpcomingSession: boolean): ArrivalFact[] {
  if (!hasUpcomingSession) return [];
  return ['offline', 'transfer'];
}
