/**
 * "Today" on a calendar: one rule, shared by the organizer and admin consoles.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ──────────────────────────────────────────────────
 * The two calendars disagreed about what day it was. The organizer calendar took today from the
 * browser's zone; the admin calendar called the same kind of helper without a zone, which fell
 * through to UTC. From six in the evening in Denver (midnight UTC) until midnight in Denver, the
 * organizer console highlighted the 9th and the admin console the 10th, on the same machine at
 * the same instant. Neither was a bug on its own terms; together they were two answers to one
 * question, and an operator comparing the two screens could not tell which one was wrong.
 *
 * ── THE POLICY ─────────────────────────────────────────────────────────────────────
 * 1. "Today" is the VIEWER's local calendar date: the date on the clock of the person reading the
 *    calendar, in the zone their browser reports. It is computed from an instant that is passed
 *    in, never read from a clock inside this file, so a test can pin it.
 * 2. Each SESSION sits on its VENUE's local date and is labelled with the venue's zone. That rule
 *    already lives in each app's `lib/calendar.ts` and is unchanged here.
 * 3. Because the two can differ - a 22:00 show in Hyderabad is "tomorrow morning" to a reader in
 *    Denver - the calendar says which zone "today" was taken in, next to the Today button.
 *
 * The viewer's zone, and not the venue's, because "today" has to be one day for the whole grid,
 * and a grid can hold venues in several zones at once. The server's clock is never used: it runs
 * in UTC and knows nothing about the person reading.
 */

/** Today on the viewer's clock, and the zone that decided it. */
export interface ViewerToday {
  /** The viewer's local calendar date, `YYYY-MM-DD`. */
  day: string;
  /** The IANA zone the day was taken in. `UTC` when the browser reported nothing usable. */
  zone: string;
  /** The zone's short name at that instant ("MDT", "GMT+5:30", "UTC"), so DST shows. */
  zoneShort: string;
}

/*
  Chromium's ICU still reports some zones by their old names: a browser in India says
  `Asia/Calcutta`. Both names work, but a reader in Hyderabad should see the name the rest of the
  product uses (every venue in India is stored as `Asia/Kolkata`), so the old ones are renamed for
  display. An explicit list, not a library: these are the renames a launch market can meet.
*/
const RENAMED_ZONES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
};

function usableZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return RENAMED_ZONES[zone] ?? zone;
  } catch {
    return null;
  }
}

/**
 * The zone the browser (or runtime) reports for its user, or `UTC` when it reports none.
 *
 * UTC is the fallback rather than any market's zone: a guessed zone is a wrong day for everybody
 * outside that market, and the calendar names the zone it used, so a UTC day is at least honest.
 */
export function viewerTimeZone(): string {
  try {
    return usableZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Today on the viewer's clock at `now`.
 *
 * `zone` defaults to the viewer's own; it is a parameter so a test can hold the instant and the
 * zone fixed and get the same answer on any machine. An unknown zone is reported as UTC, not
 * silently swapped, so the label never names a zone that was not used.
 */
export function viewerToday(now: Date, zone: string = viewerTimeZone()): ViewerToday {
  const used = usableZone(zone) ?? 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: used,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    zone: used,
    zoneShort: get('timeZoneName') || used,
  };
}

/**
 * The zone "today" was taken in, for a line beside the Today button: "America/Denver (MDT)".
 *
 * The short name is dropped when it says nothing the IANA name does not ("UTC (UTC)").
 */
export function viewerZoneLabel(today: Pick<ViewerToday, 'zone' | 'zoneShort'>): string {
  return today.zoneShort && today.zoneShort !== today.zone
    ? `${today.zone} (${today.zoneShort})`
    : today.zone;
}
