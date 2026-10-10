import type {
  NotificationFeed,
  NotificationFeedGroup,
  OrganizerAnalytics,
  OrganizerCalendarSession,
} from '@eticketsgo/web-kit';

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
