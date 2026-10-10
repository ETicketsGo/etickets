import {
  dateTime,
  zoneAbbrev,
  type BadgeTone,
  type ImageCategory,
  type OrgEventRow,
  type SellingState,
} from '@eticketsgo/web-kit';
import { venueZone, type EventSaleState, type SaleStateKind } from '@eticketsgo/shared-types';

/**
 * The organizer's event list and overview, as data: what each event is called, when it is on,
 * and how the list is filtered and ordered. No React, so every rule here is tested as a value.
 */

/** One currency's confirmed sales for an event. Gross: fees and refunds are on the report. */
export interface EventSalesLine {
  currency: string;
  grossMinor: number;
  bookings: number;
}

/**
 * A row of `GET /events?organizationId=` as the API sends it now.
 *
 * Declared here rather than on web-kit's `OrgEventRow` so this workstream does not edit the
 * shared API types while other console work is in flight; every field beyond the old row is
 * optional, so a response from an API that predates them still renders (as "no sessions yet",
 * "0 / 0", and no sales line) rather than throwing.
 */
export interface EventListRow extends OrgEventRow {
  venueId?: string;
  publishedAt?: string | null;
  reviewNote?: string | null;
  needsReviewOnResume?: boolean;
  pausedByAdmin?: boolean;
  isFree?: boolean;
  venue: OrgEventRow['venue'] & { country?: string | null; timezone?: string | null };
  imagePath?: string | null;
  imageVariants?: Partial<Record<string, string>> | null;
  schedule?: {
    firstStartsAt: string | null;
    lastStartsAt: string | null;
    nextStartsAt: string | null;
    upcomingSessions: number;
  };
  tickets?: { sold: number; capacity: number };
  /** Null when the member may not see money; empty when nothing has sold. */
  sales?: EventSalesLine[] | null;
}

/**
 * Where an event stands with the platform's reviewers, said apart from its status.
 *
 * Status answers "is it selling"; this answers "has it been approved". They are different
 * questions: a PAUSED event was approved, a DRAFT may have been sent back with a note, and a
 * paused event edited since may need review again before it can resume. All of it is read from
 * fields the event already carries - nothing here is a second source of truth.
 */
export function approvalOf(event: {
  status: string;
  publishedAt?: string | null;
  reviewNote?: string | null;
  needsReviewOnResume?: boolean;
  pausedByAdmin?: boolean;
}): { label: string; tone: BadgeTone } {
  if (event.status === 'UNDER_REVIEW') return { label: 'Awaiting approval', tone: 'warning' };
  // A rejection puts the event back to DRAFT with the reviewer's note and no publish date.
  if (event.status === 'DRAFT')
    return event.reviewNote && !event.publishedAt
      ? { label: 'Changes requested', tone: 'error' }
      : { label: 'Not submitted', tone: 'neutral' };
  if (event.status === 'PAUSED' && event.pausedByAdmin)
    return { label: 'Paused by platform', tone: 'error' };
  if (event.status === 'PAUSED' && event.needsReviewOnResume)
    return { label: 'Review needed to resume', tone: 'warning' };
  if (event.publishedAt) return { label: 'Approved', tone: 'success' };
  return { label: 'Never published', tone: 'neutral' };
}

/** The zone an event's times are shown in, and whether it is really the venue's. */
export function eventZone(venue: { timezone?: string | null; country?: string | null }): {
  zone: string | undefined;
  known: boolean;
} {
  const zone = venueZone(venue.timezone, venue.country);
  return zone ? { zone, known: true } : { zone: undefined, known: false };
}

/**
 * A start time as the time AT THE VENUE, with the zone's short name: "14 Nov 2026, 7:30 pm IST".
 *
 * A time with no zone is the ambiguity that once had a ticket and its email disagree by hours.
 * When the venue has no zone the reader's own is used and said to be theirs, rather than
 * passed off as the venue's.
 */
export function timeAtVenue(
  iso: string,
  venue: { timezone?: string | null; country?: string | null },
): string {
  const { zone, known } = eventZone(venue);
  const when = dateTime(iso, 'en-IN', zone);
  if (!known) return `${when} (your time)`;
  const abbrev = zoneShortName(iso, zone!);
  return abbrev ? `${when} ${abbrev}` : when;
}

/**
 * The zone's short name an organizer would say: "IST", "CDT", "EST".
 *
 * Each English locale knows the names of its own region's zones and spells the rest as an
 * offset - en-US says "GMT+5:30" for India, en-IN says "IST" but "GMT-5" for Chicago. Both are
 * asked, and the first real name wins; an offset is the fallback, which is never wrong.
 */
export function zoneShortName(iso: string, zone: string): string {
  const names = ['en-US', 'en-IN'].map((locale) => {
    try {
      return (
        new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
          .formatToParts(new Date(iso))
          .find((p) => p.type === 'timeZoneName')?.value ?? ''
      );
    } catch {
      return '';
    }
  });
  return names.find((n) => n && !/^(GMT|UTC)/.test(n)) ?? (names[0] || zoneAbbrev(iso, zone));
}

export interface ScheduleSummary {
  /** "Next", "Last" or null when there are no sessions. */
  lead: 'Next' | 'Last' | null;
  /** The session's time at the venue, or the reason there is none. */
  when: string;
  /** "+3 more sessions", or null. */
  more: string | null;
}

/**
 * The one line a list shows about when an event is on.
 *
 * The NEXT session while any has not ended - that is what an organizer acts on - counting the
 * rest that are still to come. Once every session is over, the last one, so a finished event
 * says when it finished rather than "no sessions".
 */
export function scheduleSummary(event: EventListRow): ScheduleSummary {
  const s = event.schedule;
  if (s?.nextStartsAt) {
    const rest = s.upcomingSessions - 1;
    return {
      lead: 'Next',
      when: timeAtVenue(s.nextStartsAt, event.venue),
      more: rest > 0 ? `+${rest} more session${rest === 1 ? '' : 's'}` : null,
    };
  }
  if (s?.lastStartsAt) {
    return { lead: 'Last', when: timeAtVenue(s.lastStartsAt, event.venue), more: null };
  }
  return { lead: null, when: 'No sessions yet', more: null };
}

/** The calendar date of an instant in a zone, YYYY-MM-DD - comparable as a string. */
export function localDate(iso: string, zone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface EventFilters {
  q: string;
  status: string;
  venue: string;
  category: string;
  /** Inclusive, YYYY-MM-DD at the venue. Empty means open. */
  from: string;
  to: string;
  /** The server's unified sale state, or empty for any. See `filterBySale`. */
  sale: SaleFilter;
}

export type SaleFilter = '' | SaleStateKind;

export const SALE_FILTER_LABELS: Record<SaleStateKind, string> = {
  SELLING: 'Selling',
  PARTIAL: 'Partly selling',
  NOT_SELLING: 'Not selling',
};

export const NO_FILTERS: EventFilters = {
  q: '',
  status: '',
  venue: '',
  category: '',
  from: '',
  to: '',
  sale: '',
};

/** The venue an event filters by: its id where the API sends one, else its name. */
export function venueKey(event: EventListRow): string {
  return event.venueId ?? event.venue.name;
}

/**
 * The events that pass every filter.
 *
 * The date range is matched against the span from the first session to the last, in each
 * venue's own calendar: an event whose run overlaps the range is in it. The list carries the
 * span, not every session, so an event with a session before the range and one after it - and
 * none inside - still counts. For a list of an organization's events that is the honest
 * reading of "on during these dates"; the Sessions page has every date.
 */
export function filterEvents(rows: EventListRow[], f: EventFilters): EventListRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((e) => {
    if (f.status && e.status !== f.status) return false;
    if (f.category && e.category !== f.category) return false;
    if (f.venue && venueKey(e) !== f.venue) return false;
    if (
      q &&
      !e.title.toLowerCase().includes(q) &&
      !e.venue.name.toLowerCase().includes(q) &&
      !e.venue.city.toLowerCase().includes(q)
    )
      return false;
    if (f.from || f.to) {
      const first = e.schedule?.firstStartsAt;
      const last = e.schedule?.lastStartsAt;
      // An event with no sessions is on no date, so a date filter leaves it out.
      if (!first || !last) return false;
      const { zone } = eventZone(e.venue);
      if (f.from && localDate(last, zone) < f.from) return false;
      if (f.to && localDate(first, zone) > f.to) return false;
    }
    return true;
  });
}

export type EventSort = 'newest' | 'date' | 'name' | 'sold' | 'gross';

export const SORT_LABELS: Record<EventSort, string> = {
  newest: 'Newest first',
  date: 'Next session',
  name: 'Name (A to Z)',
  sold: 'Most tickets sold',
  gross: 'Gross sales',
};

const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);

/** The currency an event mostly sold in, and how much: its largest sales line. */
function topSale(e: EventListRow): EventSalesLine | null {
  return e.sales?.[0] ?? null;
}

/**
 * The list in the chosen order. Never sorts the caller's array in place.
 *
 * - date: the next session soonest; events with nothing to come follow, most recent first;
 *   events with no sessions at all come last.
 * - gross: grouped by currency, then largest first within it. Amounts in two currencies are
 *   not comparable - ranking a $500 event below a 600-rupee one by raw minor units is the
 *   mistake the dashboard's top events once made - so the order never puts them on one scale.
 * Ties fall back to the title, so the order is stable between renders.
 */
export function sortEvents(rows: EventListRow[], sort: EventSort): EventListRow[] {
  const byTitle = (a: EventListRow, b: EventListRow) => a.title.localeCompare(b.title);
  const list = [...rows];
  switch (sort) {
    case 'newest':
      return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byTitle(a, b));
    case 'name':
      return list.sort(byTitle);
    case 'sold':
      return list.sort((a, b) => (b.tickets?.sold ?? 0) - (a.tickets?.sold ?? 0) || byTitle(a, b));
    case 'gross':
      return list.sort((a, b) => {
        const sa = topSale(a);
        const sb = topSale(b);
        if (!sa || !sb) return (sa ? -1 : 0) + (sb ? 1 : 0) || byTitle(a, b);
        return (
          sa.currency.localeCompare(sb.currency) || sb.grossMinor - sa.grossMinor || byTitle(a, b)
        );
      });
    case 'date':
      return list.sort((a, b) => {
        const rank = (e: EventListRow) =>
          e.schedule?.nextStartsAt ? 0 : e.schedule?.lastStartsAt ? 1 : 2;
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0)
          return time(a.schedule!.nextStartsAt)! - time(b.schedule!.nextStartsAt)! || byTitle(a, b);
        if (ra === 1)
          return time(b.schedule!.lastStartsAt)! - time(a.schedule!.lastStartsAt)! || byTitle(a, b);
        return byTitle(a, b);
      });
  }
}

/** The distinct values a filter offers, from the events themselves, sorted for reading. */
export function filterOptions(rows: EventListRow[]): {
  venues: { value: string; label: string }[];
  categories: string[];
} {
  const venues = new Map<string, string>();
  const categories = new Set<string>();
  for (const e of rows) {
    venues.set(venueKey(e), `${e.venue.name}, ${e.venue.city}`);
    if (e.category) categories.add(e.category);
  }
  return {
    venues: [...venues]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
  };
}

/** "35 / 150", or "35 sold" when nothing has a set capacity - never a division by zero. */
export function soldOfCapacity(tickets: { sold: number; capacity: number } | undefined): {
  label: string;
  /** 0..100, or null when there is no capacity to fill. */
  percent: number | null;
} {
  const sold = tickets?.sold ?? 0;
  const capacity = tickets?.capacity ?? 0;
  if (capacity <= 0) return { label: `${sold} sold`, percent: null };
  return {
    label: `${sold} / ${capacity}`,
    percent: Math.min(100, Math.round((sold / capacity) * 100)),
  };
}

/**
 * The events in one sale state, as the SERVER answered for each.
 *
 * Sale state is not on the list row - it is the unified answer from
 * `event-sale-eligibility`, asked for separately - so this filter runs after the others, over
 * the answers that have arrived. An event with no answer yet is left out rather than guessed
 * into a bucket: a "Selling" filter that showed an unchecked event would be the bare
 * "Selling" the status rules forbid. `pending` says how many were left out for that reason, so
 * the page can say it is still checking instead of showing a short list as if it were final.
 */
export function filterBySale(
  rows: EventListRow[],
  sale: SaleFilter,
  stateOf: (eventId: string) => SaleStateKind | undefined,
): { rows: EventListRow[]; pending: number } {
  if (!sale) return { rows, pending: 0 };
  let pending = 0;
  const kept = rows.filter((e) => {
    const state = stateOf(e.id);
    if (state === undefined) {
      pending += 1;
      return false;
    }
    return state === sale;
  });
  return { rows: kept, pending };
}

/**
 * The server's answer as the design system's selling pill: "Selling", "Partly selling:
 * <reason>" or "Not selling: <reason>" - the same words `saleStateLabel` writes, so the pill,
 * the overview and checkout's refusal cannot disagree. Null while there is no answer: the
 * caller says it is checking (or could not check), never "Selling".
 */
export function sellingStateOf(
  answer: Pick<EventSaleState, 'state' | 'reasons'> | undefined,
): SellingState | null {
  if (!answer) return null;
  if (answer.state === 'SELLING') return { state: 'selling' };
  const lead = answer.reasons[0]?.text;
  return answer.state === 'PARTIAL'
    ? { state: 'partly', reason: lead ?? 'some tickets are closed' }
    : { state: 'not', reason: lead ?? 'checkout would refuse it' };
}

/**
 * Which branded placeholder an event without a picture gets. The organizer types the
 * category, so it is matched loosely; anything unknown is a plain event ticket.
 */
export function imageCategoryOf(category: string | null | undefined): ImageCategory {
  const c = (category ?? '').trim().toLowerCase();
  if (/movie|film|cinema/.test(c)) return 'movie';
  if (/music|concert|festival/.test(c)) return 'music';
  if (/comedy|stand ?up/.test(c)) return 'comedy';
  if (/sport|kabaddi|cricket|football/.test(c)) return 'sports';
  if (/conference|tech|workshop|talk|summit/.test(c)) return 'conference';
  return 'event';
}

/** The list's view, remembered on this device. */
export type EventListView = 'cards' | 'table' | 'calendar';
export const VIEW_STORAGE_KEY = 'etg_organizer_events_view';

export function parseView(stored: string | null | undefined): EventListView {
  return stored === 'table' || stored === 'calendar' ? stored : 'cards';
}
