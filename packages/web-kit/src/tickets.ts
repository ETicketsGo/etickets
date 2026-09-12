// Pure, framework-free logic for the customer ticket wallet: grouping tickets by
// booking, summarizing group status/check-in progress, sorting seats naturally,
// and choosing which ticket the viewer should open first. No React, no DOM — so
// it is directly unit-testable and shared by the wallet page and ticket viewer.
//
// It only *reads* ticket status; it never mutates booking, refund, or check-in
// state. Status strings mirror the API's TicketStatus enum.

import type { WalletTicket } from './api';

export type GroupStatusTone = 'success' | 'info' | 'warning' | 'error' | 'neutral';

export interface GroupCounts {
  total: number;
  active: number;
  checkedIn: number;
  refunded: number;
  cancelled: number;
  transferred: number;
  /** Any other/unknown state — still counted, never hidden. */
  other: number;
}

export interface BookingGroup {
  /** Stable key: the bookingId, or the ticket id when grouping older payloads. */
  bookingId: string;
  bookingRef: string;
  title: string;
  slug: string;
  startsAt: string;
  experienceType: string;
  isMovie: boolean;
  venueName: string | null;
  screenName: string | null;
  cinemaName: string | null;
  /** Single ticket-type name, or "N ticket types" when a booking mixes them. */
  ticketTypeSummary: string;
  /** Naturally-sorted seat labels present on the booking (movies / reserved seating). */
  seatLabels: string[];
  /** Tickets in display order (seats sorted for movies, else by serial). */
  tickets: WalletTicket[];
  counts: GroupCounts;
  /** Human status summary, e.g. "2 checked in · 6 remaining", "All checked in". */
  summary: string;
  /** e.g. "3 of 8 checked in". */
  checkInProgress: string;
  statusTone: GroupStatusTone;
}

const CHECKED_IN = 'CHECKED_IN';
const ACTIVE = 'ACTIVE';

/** Tickets that are no longer usable at the gate — visually de-emphasized, never hidden. */
export function isTicketInactive(status: string): boolean {
  return (
    status === CHECKED_IN || status === 'REFUNDED' || status === 'CANCELLED' || status === 'VOID'
  );
}

/**
 * Natural seat-label ordering: row letters first, then seat number numerically,
 * so "A2" precedes "A10" and "B1" follows all of row A. Robust to plain labels.
 */
export function compareSeatLabels(a: string, b: string): number {
  const parse = (s: string) => {
    const m = /^\s*([A-Za-z]*)\s*0*(\d+)?/.exec(s) ?? [];
    return { row: (m[1] ?? '').toUpperCase(), num: m[2] != null ? parseInt(m[2], 10) : null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.row !== pb.row) return pa.row < pb.row ? -1 : 1;
  if (pa.num != null && pb.num != null && pa.num !== pb.num) return pa.num - pb.num;
  return a.localeCompare(b, undefined, { numeric: true });
}

export function countByStatus(tickets: WalletTicket[]): GroupCounts {
  const c: GroupCounts = {
    total: tickets.length,
    active: 0,
    checkedIn: 0,
    refunded: 0,
    cancelled: 0,
    transferred: 0,
    other: 0,
  };
  for (const t of tickets) {
    switch (t.status) {
      case ACTIVE:
        c.active++;
        break;
      case CHECKED_IN:
        c.checkedIn++;
        break;
      case 'REFUNDED':
        c.refunded++;
        break;
      case 'CANCELLED':
      case 'VOID':
        c.cancelled++;
        break;
      case 'TRANSFERRED':
        c.transferred++;
        break;
      default:
        c.other++;
    }
  }
  return c;
}

/**
 * Index of the next ACTIVE ticket after `fromIndex`, wrapping around; `-1` if the
 * group has none. Powers "next active QR" and check-in auto-advance.
 */
export function nextActiveIndex(tickets: WalletTicket[], fromIndex: number): number {
  for (let step = 1; step <= tickets.length; step++) {
    const i = (fromIndex + step) % tickets.length;
    if (tickets[i].status === ACTIVE) return i;
  }
  return -1;
}

/** One counted part of a group summary, e.g. "2 checked in". `tickets` is the fallback count. */
export type SummarySegment =
  | 'refunded'
  | 'cancelled'
  | 'transferred'
  | 'checkedIn'
  | 'remaining'
  | 'active'
  | 'other'
  | 'tickets';

/**
 * The words a group summary is built from.
 *
 * Optional, with English defaults, so the storefront can pass its translations (French agrees
 * the word with the count: "1 actif", "2 actifs") while the rule for WHICH segments appear stays
 * here, in one place.
 */
export interface GroupSummaryWords {
  allCheckedIn: string;
  bookingCancelled: string;
  segment: (kind: SummarySegment, count: number) => string;
}

const ENGLISH_SEGMENT: Record<Exclude<SummarySegment, 'tickets'>, string> = {
  refunded: 'refunded',
  cancelled: 'cancelled',
  transferred: 'transferred',
  checkedIn: 'checked in',
  remaining: 'remaining',
  active: 'active',
  other: 'other',
};

export const ENGLISH_SUMMARY_WORDS: GroupSummaryWords = {
  allCheckedIn: 'All checked in',
  bookingCancelled: 'Booking cancelled',
  segment: (kind, n) =>
    kind === 'tickets' ? `${n} ticket${n === 1 ? '' : 's'}` : `${n} ${ENGLISH_SEGMENT[kind]}`,
};

/**
 * Builds the group-level status summary and tone from ticket counts.
 * Communicates status with words (never colour alone); the tone only tints an
 * accompanying icon/badge.
 */
export function summarizeBookingGroup(
  c: GroupCounts,
  words: GroupSummaryWords = ENGLISH_SUMMARY_WORDS,
): { summary: string; tone: GroupStatusTone } {
  const usable = c.active + c.transferred + c.other;
  const w = words.segment;

  let summary: string;
  if (c.total > 0 && c.checkedIn === c.total) {
    summary = words.allCheckedIn;
  } else if (c.total > 0 && usable === 0 && c.checkedIn === 0) {
    summary = words.bookingCancelled;
  } else {
    const seg: string[] = [];
    if (c.refunded) seg.push(w('refunded', c.refunded));
    if (c.cancelled) seg.push(w('cancelled', c.cancelled));
    if (c.transferred) seg.push(w('transferred', c.transferred));
    if (c.checkedIn && c.active) {
      seg.push(w('checkedIn', c.checkedIn), w('remaining', c.active));
    } else {
      if (c.checkedIn) seg.push(w('checkedIn', c.checkedIn));
      if (c.active) seg.push(w('active', c.active));
    }
    if (c.other) seg.push(w('other', c.other));
    summary = seg.join(' · ') || w('tickets', c.total);
  }

  let tone: GroupStatusTone = 'neutral';
  if (c.active > 0) tone = 'success';
  else if (c.total > 0 && c.checkedIn === c.total) tone = 'info';
  else if (c.total > 0 && c.refunded + c.cancelled === c.total) tone = 'error';
  else if (c.refunded || c.cancelled) tone = 'warning';

  return { summary, tone };
}

/**
 * Which ticket the viewer opens first:
 *   1. the first ACTIVE ticket,
 *   2. otherwise the first not-yet-checked-in ticket,
 *   3. otherwise the first ticket.
 * Returns 0 for an empty list.
 */
export function pickInitialTicketIndex(tickets: WalletTicket[]): number {
  const firstActive = tickets.findIndex((t) => t.status === ACTIVE);
  if (firstActive >= 0) return firstActive;
  const firstOpen = tickets.findIndex((t) => t.status !== CHECKED_IN);
  if (firstOpen >= 0) return firstOpen;
  return 0;
}

function buildGroup(key: string, input: WalletTicket[]): BookingGroup {
  const first = input[0];
  const experienceType = first.experienceType ?? 'EVENT';
  const isMovie = experienceType === 'MOVIE';

  // Sort seats naturally for reserved-seating (movie) bookings; otherwise keep a
  // stable serial order. Sorting is a copy — never mutate the input array.
  const tickets = [...input].sort((a, b) => {
    if (a.seatLabel && b.seatLabel) return compareSeatLabels(a.seatLabel, b.seatLabel);
    return a.serial.localeCompare(b.serial, undefined, { numeric: true });
  });

  const seatLabels = tickets.map((t) => t.seatLabel).filter((s): s is string => !!s);

  const typeNames = Array.from(new Set(tickets.map((t) => t.ticketType)));
  const ticketTypeSummary =
    typeNames.length === 1 ? typeNames[0] : `${typeNames.length} ticket types`;

  const counts = countByStatus(tickets);
  const { summary, tone } = summarizeBookingGroup(counts);

  return {
    bookingId: key,
    bookingRef: first.bookingRef ?? key.slice(-6).toUpperCase(),
    title: first.event.title,
    slug: first.event.slug,
    startsAt: first.startsAt,
    experienceType,
    isMovie,
    venueName: first.venueName ?? null,
    screenName: first.screenName ?? null,
    cinemaName: first.cinemaName ?? null,
    ticketTypeSummary,
    seatLabels,
    tickets,
    counts,
    summary,
    checkInProgress: `${counts.checkedIn} of ${counts.total} checked in`,
    statusTone: tone,
  };
}

/**
 * Groups a flat wallet response into per-booking groups. Tickets are grouped by
 * `bookingId`; a payload without it (older API) falls back to one group per
 * ticket so nothing breaks. Group order follows first appearance in the input
 * (the API returns newest booking first). Tickets from different bookings are
 * never merged, even when event/session/type match.
 */
export function groupWalletTickets(tickets: WalletTicket[]): BookingGroup[] {
  const order: string[] = [];
  const byBooking = new Map<string, WalletTicket[]>();
  for (const t of tickets) {
    const key = t.bookingId ?? t.id;
    const bucket = byBooking.get(key);
    if (bucket) {
      bucket.push(t);
    } else {
      byBooking.set(key, [t]);
      order.push(key);
    }
  }
  return order.map((key) => buildGroup(key, byBooking.get(key)!));
}
