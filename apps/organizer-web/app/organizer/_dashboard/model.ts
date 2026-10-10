import type {
  NotificationFeed,
  NotificationFeedGroup,
  OrganizerAnalytics,
  OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import {
  addDays,
  endOfMonth,
  fetchWindow,
  localPlace,
  sessionZone,
  startOfMonth,
} from '../../../lib/calendar';

/**
 * What the organizer dashboard shows, worked out from what the API already returns.
 *
 * ── NO NEW FIGURES ─────────────────────────────────────────────────────────────────
 * Everything here is a selection or a ratio of fields the API sends; nothing is estimated,
 * projected or converted. In particular money is NEVER added across currencies: there is no
 * exchange-rate source on this platform, so a total of rupees and dollars is not an amount
 * anybody was charged. The dashboard shows one market at a time and says which.
 *
 * Kept apart from the page so the rules can be tested without rendering it.
 */

export interface MarketChoice {
  currency: string;
  label: string;
}

/**
 * Which market the page opens on.
 *
 * The organizer's own choice, then the market of the country they registered in, then the
 * first one the API listed. An Indian promoter opens on rupees even if their one US test
 * booking happened to come back first.
 */
export function pickCurrency(
  choices: MarketChoice[],
  homeCurrency: string | null,
  chosen: string | null,
): string | null {
  if (chosen && choices.some((c) => c.currency === chosen)) return chosen;
  if (homeCurrency && choices.some((c) => c.currency === homeCurrency)) return homeCurrency;
  return choices[0]?.currency ?? null;
}

/** The money for ONE currency. Every figure is that currency's own, or zero. */
export interface MarketMoney {
  currency: string;
  /** Ticket sales on paid bookings, before fees. */
  grossMinor: number;
  /** Fees taken from the organizer on those sales. */
  organizerFeesMinor: number;
  /** What the organizer keeps: gross, less their fees, less completed refunds (API-computed). */
  netMinor: number;
  /** Booking fees on those bookings, charged to buyers. Not part of the organizer's proceeds. */
  bookingFeesMinor: number;
  refundsMinor: number;
  refundRate: number;
  couponRedemptions: number;
  couponDiscountMinor: number;
}

export function moneyFor(analytics: OrganizerAnalytics | undefined, currency: string): MarketMoney {
  const revenue = analytics?.revenue?.find((r) => r.currency === currency);
  const refunds = analytics?.refunds?.find((r) => r.currency === currency);
  const coupons = analytics?.coupons?.find((c) => c.currency === currency);
  return {
    currency,
    grossMinor: revenue?.grossMinor ?? 0,
    organizerFeesMinor: revenue?.organizerFeesMinor ?? 0,
    netMinor: revenue?.netMinor ?? 0,
    bookingFeesMinor: revenue?.bookingFeesMinor ?? 0,
    refundsMinor: refunds?.amountMinor ?? 0,
    refundRate: refunds?.refundRate ?? 0,
    couponRedemptions: coupons?.redemptions ?? 0,
    couponDiscountMinor: coupons?.discountMinor ?? 0,
  };
}

export interface EventPerformance {
  eventId: string;
  title: string;
  currency: string;
  grossMinor: number;
  bookings: number;
  /** This event's gross as a share of the best event's, 0-100, within the same currency. */
  relative: number;
}

/**
 * The top events in ONE market, each with a bar relative to the best of them.
 *
 * Ranked within the selected currency: a top five across currencies ranks by exchange
 * accident, which is not a ranking.
 */
export function performanceFor(
  analytics: OrganizerAnalytics | undefined,
  currency: string | null,
  limit = 5,
): EventPerformance[] {
  const rows = (analytics?.topEvents ?? []).filter((e) => e.currency === currency).slice(0, limit);
  const best = Math.max(0, ...rows.map((r) => r.grossMinor));
  return rows.map((r) => ({
    ...r,
    relative: best > 0 ? Math.round((r.grossMinor / best) * 100) : 0,
  }));
}

/** The groups in the feed's action section that are still a problem, newest first. */
export function pendingActions(feed: NotificationFeed | undefined): NotificationFeedGroup[] {
  const section = feed?.sections.find((s) => s.category === 'ACTION_REQUIRED');
  return (section?.groups ?? [])
    .filter((g) => g.resolved !== true)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

/**
 * The latest things that happened, from every other section of the feed.
 *
 * Not the action section: those are already listed as pending, and showing the same card
 * twice on one page reads as two problems.
 */
export function recentActivity(
  feed: NotificationFeed | undefined,
  limit = 6,
): NotificationFeedGroup[] {
  return (feed?.sections ?? [])
    .filter((s) => s.category !== 'ACTION_REQUIRED')
    .flatMap((s) => s.groups)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .slice(0, limit);
}

/** How far ahead "Coming up" looks. A week is what an organizer plans staff and stock around. */
export const COMING_UP_DAYS = 7;

/**
 * How far ahead the Overview looks for an event's NEXT show, to say whether it is selling.
 * Within the calendar endpoint's 62-day ceiling; a show further out is said as such.
 */
export const NEXT_SHOW_DAYS = 60;

/** A calendar window from now, `days` ahead ("Coming up" by default), as ISO instants. */
export function comingUpWindow(
  now: Date = new Date(),
  days: number = COMING_UP_DAYS,
): { from: string; to: string } {
  const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return { from: now.toISOString(), to: to.toISOString() };
}

/**
 * The next shows, soonest first: not cancelled, not already started, from a live event.
 *
 * A cancelled show or one from an archived event is on the calendar for the record, but it is
 * not "coming up" - listing it here would tell an organizer to prepare for something that is
 * not going to happen.
 */
export function comingUp(
  sessions: OrganizerCalendarSession[] | undefined,
  now: Date = new Date(),
  limit = 5,
): OrganizerCalendarSession[] {
  const t = now.getTime();
  return (sessions ?? [])
    .filter(
      (s) =>
        s.status !== 'CANCELLED' &&
        !['CANCELLED', 'ARCHIVED'].includes(s.event.status) &&
        Date.parse(s.startsAt) >= t,
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit);
}

/** Shows that start before `days` from now: the week's programme out of a longer window. */
export function startingWithin(
  sessions: OrganizerCalendarSession[] | undefined,
  days: number,
  now: Date = new Date(),
): OrganizerCalendarSession[] {
  const until = now.getTime() + days * 24 * 60 * 60 * 1000;
  return (sessions ?? []).filter((s) => Date.parse(s.startsAt) < until);
}

/**
 * Each event's next show that is still to come and not cancelled - what "is this event
 * selling" is judged by. An event absent from the map has no such show in the window read.
 */
export function nextShowByEvent(
  sessions: OrganizerCalendarSession[] | undefined,
  now: Date = new Date(),
): Map<string, OrganizerCalendarSession> {
  const out = new Map<string, OrganizerCalendarSession>();
  for (const s of comingUp(sessions, now, Number.POSITIVE_INFINITY)) {
    if (!out.has(s.event.id)) out.set(s.event.id, s);
  }
  return out;
}

// ─── The premium Overview: hero, upcoming event cards, the month card ──────────────

/** A calendar day label, `YYYY-MM-DD`, as `lib/calendar` names one. */
export type DayKey = string;

/** Today's date in THIS browser's zone - the viewer's own "today", for the greeting and the ring. */
export function viewerToday(now: Date = new Date(), zone?: string): DayKey {
  return localPlace(now, zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone).day;
}

/** "Saturday, 10 October 2026": the greeting's date, in the viewer's zone. */
export function greetingDate(now: Date = new Date(), zone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}

/** "Sat, 10 Oct 2026": the greeting's date on a phone. */
export function greetingDateShort(now: Date = new Date(), zone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(now);
}

/** How many days ahead the Overview's calendar read reaches past today, inside the API's 62. */
export const HOME_DAYS_AHEAD = 27;

/**
 * The one calendar window the Overview reads on arrival: the whole of this month (for the month
 * card's dots) and the next four weeks (for "Upcoming events", which must not go blank on the
 * 30th). At most 31 + 27 days plus a day's padding each side - always under the API's 62.
 */
export function homeWindow(today: DayKey): { from: string; to: string } {
  const ahead = addDays(today, HOME_DAYS_AHEAD);
  const monthEnd = endOfMonth(today);
  return fetchWindow({ from: startOfMonth(today), to: ahead > monthEnd ? ahead : monthEnd });
}

/** A month card's window: the month's days, padded for every venue zone. */
export function monthWindow(anyDayOfMonth: DayKey): { from: string; to: string } {
  return fetchWindow({ from: startOfMonth(anyDayOfMonth), to: endOfMonth(anyDayOfMonth) });
}

/** Whether a show is really going to happen: not cancelled, from an event that is not either. */
function isOn(s: OrganizerCalendarSession): boolean {
  return s.status !== 'CANCELLED' && !['CANCELLED', 'ARCHIVED'].includes(s.event.status);
}

/** The date a show is on AT ITS VENUE - the calendar's own rule, never the browser's date. */
export function venueDay(s: OrganizerCalendarSession): DayKey {
  return localPlace(s.startsAt, sessionZone(s).zone).day;
}

/**
 * How many shows each venue-local date has, for the dots under the month card's days.
 * Cancelled shows are on the calendar for the record, but a dot says "something is on".
 */
export function showsPerDay(sessions: OrganizerCalendarSession[] | undefined): Map<DayKey, number> {
  const out = new Map<DayKey, number>();
  for (const s of sessions ?? []) {
    if (!isOn(s)) continue;
    const day = venueDay(s);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

/** The shows on one venue-local date, earliest first. */
export function showsOnDay(
  sessions: OrganizerCalendarSession[] | undefined,
  day: DayKey,
): OrganizerCalendarSession[] {
  return (sessions ?? [])
    .filter((s) => isOn(s) && venueDay(s) === day)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * Today's shows still to start, where "today" is the date on the wall AT EACH VENUE now.
 *
 * Still to START, not still to finish: what an organizer prepares for is the next door to open.
 * A show already under way is past selling ("show has started" on every row) and listing it
 * pushed the evening's shows out of a four-row card.
 *
 * An organizer in Bengaluru with a show in Boise reads "today" as the day it is in Boise for that
 * show; using the browser's date would drop a Boise evening show from today for half of it.
 */
export function showsToday(
  sessions: OrganizerCalendarSession[] | undefined,
  now: Date = new Date(),
): OrganizerCalendarSession[] {
  return (sessions ?? [])
    .filter((s) => {
      if (!isOn(s) || Date.parse(s.startsAt) < now.getTime()) return false;
      const { zone } = sessionZone(s);
      return localPlace(s.startsAt, zone).day === localPlace(now, zone).day;
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * The next few EVENTS, each with its next show still to come - what the image cards show.
 * One card per event, soonest first; a show that has already started is not "upcoming".
 */
export function upcomingEventShows(
  sessions: OrganizerCalendarSession[] | undefined,
  now: Date = new Date(),
  limit = 3,
): OrganizerCalendarSession[] {
  return [...nextShowByEvent(sessions, now).values()].slice(0, limit);
}

/** How many different events have a show starting in the next `days` days. */
export function eventsStartingWithin(
  sessions: OrganizerCalendarSession[] | undefined,
  days: number,
  now: Date = new Date(),
): number {
  return new Set(
    comingUp(startingWithin(sessions, days, now), now, Number.POSITIVE_INFINITY).map(
      (s) => s.event.id,
    ),
  ).size;
}

/**
 * The events that still have a show to come, from the event list's own schedule summary.
 * The figure on the "Upcoming events" card: every such event, however far ahead, never only
 * the ones inside the calendar window.
 */
export function upcomingEventCount(
  events: { status: string; schedule?: { upcomingSessions: number } | null }[] | undefined,
): number {
  return (events ?? []).filter(
    (e) => !['CANCELLED', 'ARCHIVED'].includes(e.status) && (e.schedule?.upcomingSessions ?? 0) > 0,
  ).length;
}

/**
 * "Calendar, sales and payouts" - what the phone's "Show more" folds, as the button says it.
 * Lower-case parts in, a sentence out; nothing for nothing.
 */
export function listSentence(parts: string[]): string {
  if (parts.length === 0) return '';
  const text =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
