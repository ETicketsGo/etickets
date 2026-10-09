import { venueZone } from '@eticketsgo/shared-types';

/**
 * Show times are wall-clock times AT THE VENUE.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────
 * The event wizard and the sessions page turned the "2026-11-06T19:00" an organizer typed into
 * an instant with `new Date(value)`, which reads it in the BROWSER's zone. An organizer in
 * Denver creating a 19:00 concert in Hyderabad stored 19:00 Denver time - 07:30 the next
 * morning in Hyderabad - and every ticket, email and check-in screen then said so. Found on QA
 * in the 2026-10-09 paid-concert certification. The cinema scheduler had already fixed the
 * same bug for itself (`wallClockToInstant` in schedule/edit-show.tsx); this is that fix,
 * shared, for every form that takes a show time.
 */

/** A wall-clock `YYYY-MM-DDTHH:mm` in `timeZone`, as an absolute instant. */
export function wallClockToInstant(local: string, timeZone: string): Date {
  const [date, time] = local.split('T');
  /*
    Half-typed values arrive on every render - a date picked before its time. `new Date` used
    to turn those into an Invalid Date quietly; Intl.DateTimeFormat THROWS on one, which took
    the whole wizard down. So an incomplete value is an Invalid Date here too, never an error.
  */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}/.test(time ?? '')) {
    return new Date(NaN);
  }
  const naive = new Date(`${date}T${time.slice(0, 5)}:00Z`);
  if (Number.isNaN(naive.getTime())) return naive;
  const offsetMs = zoneOffsetMs(naive, timeZone);
  // The offset at the guessed instant can differ from the offset at the true instant across a
  // DST change; one correction step settles it for every real zone.
  const first = new Date(naive.getTime() - offsetMs);
  const second = zoneOffsetMs(first, timeZone);
  return second === offsetMs ? first : new Date(naive.getTime() - second);
}

/** An instant as the `YYYY-MM-DDTHH:mm` wall clock in `timeZone`, for an edit form. */
export function instantToWallClock(iso: string | Date, timeZone: string): string {
  const parts = partsIn(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * The zone a venue's show times are typed in: its own zone, else the only zone its country
 * has, else the organizer's browser zone - the last labelled as such, so a venue in a
 * multi-zone country with no zone set is at least visibly ambiguous rather than silently wrong.
 */
export function venueInputZone(
  venue?: { timezone?: string | null; country?: string | null } | null,
): {
  zone: string;
  known: boolean;
} {
  const zone = venueZone(venue?.timezone, venue?.country);
  if (zone) return { zone, known: true };
  return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, known: false };
}

/** "Asia/Kolkata (IST)" - what the field label says the times are in. */
export function zoneLabel(timeZone: string, at: Date = new Date()): string {
  const abbrev =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return abbrev && abbrev !== timeZone ? `${timeZone} (${abbrev})` : timeZone;
}

function partsIn(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = partsIn(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}
