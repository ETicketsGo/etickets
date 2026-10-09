import { countryDisplay } from './country-display';

/**
 * The pure half of the admin queues' filter bar: reading filter values out of a URL, and saying in
 * words which filters produced an empty list.
 *
 * Kept apart from the React half so it can be tested without a router, and so the meaning of a
 * day window is written once for every queue that offers one.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `from`/`to` value from the URL, or undefined.
 *
 * Only a real `YYYY-MM-DD` day is passed on. The API refuses anything else with a 400, and a
 * hand-edited link should fall back to "no window" rather than to an error page - the same rule
 * the country parameter already follows.
 */
export function parseDayParam(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!DAY.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : undefined;
}

/** Whether a window ends before it starts. The API refuses it; the bar says so first. */
export function dayWindowInverted(from: string | undefined, to: string | undefined): boolean {
  return Boolean(from && to && from > to);
}

/** "9 Oct 2026", read as the UTC day it is - never shifted into the viewer's zone. */
export function utcDayLabel(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Partially refunded", not "PARTIALLY_REFUNDED". */
export function enumLabel(value: string): string {
  const words = value.toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return value;
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

export interface FilterDescriptionInput {
  status?: string;
  /** Any extra enum-like filter a queue has, with its own name ("Kind", "Action"). */
  extra?: { name: string; value: string | undefined }[];
  country?: string;
  organizer?: string;
  event?: string;
  from?: string;
  to?: string;
  q?: string;
}

/**
 * The filters in force, as a sentence fragment, or '' when there are none.
 *
 * Used by the empty state, which has to say WHICH filters produced nothing. "No payments match"
 * on its own reads as "there are no payments", and the operator who set a date window last week
 * and forgot is exactly the one who needs to be told.
 */
export function describeFilters(f: FilterDescriptionInput): string {
  const parts: string[] = [];
  if (f.status) parts.push(`status ${enumLabel(f.status)}`);
  for (const e of f.extra ?? []) {
    if (e.value) parts.push(`${e.name.toLowerCase()} ${enumLabel(e.value)}`);
  }
  if (f.country) parts.push(`country ${countryDisplay(f.country)?.name ?? f.country}`);
  if (f.organizer) parts.push(`organizer ${f.organizer}`);
  if (f.event) parts.push(`event ${f.event}`);
  if (f.from && f.to) {
    parts.push(
      f.from === f.to
        ? `on ${utcDayLabel(f.from)} (UTC)`
        : `from ${utcDayLabel(f.from)} to ${utcDayLabel(f.to)} (UTC)`,
    );
  } else if (f.from) {
    parts.push(`from ${utcDayLabel(f.from)} (UTC)`);
  } else if (f.to) {
    parts.push(`up to ${utcDayLabel(f.to)} (UTC)`);
  }
  if (f.q) parts.push(`search "${f.q}"`);
  return parts.join(', ');
}
