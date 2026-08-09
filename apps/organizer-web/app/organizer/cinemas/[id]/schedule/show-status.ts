import type { ShowRow, ScheduleRejection } from '@eticketsgo/web-kit';

/**
 * Presentation rules for the scheduling workspace.
 *
 * Pure functions, kept out of the components so they can be tested without a browser and
 * so the same vocabulary is used everywhere. The server is authoritative for every decision
 * here — none of this recomputes overlap or bookability, it only describes what the server
 * already said.
 */

/** Mirrors web-kit's BadgeTone; there is no 'danger', the error tone is called 'error'. */
export type ShowTone = 'success' | 'warning' | 'error' | 'neutral';

export interface ShowPresentation {
  label: string;
  tone: ShowTone;
  /**
   * Spoken by screen readers and shown as text next to the badge.
   *
   * Operational state is never communicated by colour alone: a paused show and a cancelled
   * show are both "not selling", and a theater manager scanning a day at a glance must be
   * able to tell them apart without relying on hue.
   */
  srText: string;
}

export function presentShow(status: string): ShowPresentation {
  switch (status.toUpperCase()) {
    case 'SCHEDULED':
      return { label: 'On sale', tone: 'success', srText: 'On sale' };
    case 'PAUSED':
      return { label: 'Sales paused', tone: 'warning', srText: 'Sales paused' };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'error', srText: 'Cancelled' };
    case 'COMPLETED':
      return { label: 'Finished', tone: 'neutral', srText: 'Finished' };
    default:
      // An unrecognised status from a newer API renders as itself rather than vanishing.
      return { label: status, tone: 'neutral', srText: status };
  }
}

/** Which actions the server would currently accept. Mirrors show-operations.ts. */
export interface AvailableActions {
  pause: boolean;
  reopen: boolean;
  cancel: boolean;
  edit: boolean;
}

/**
 * What to offer in a show's action menu.
 *
 * Deliberately a MIRROR of the server policy, not a replacement for it. Hiding an action the
 * server would refuse keeps the UI honest; showing one it would accept keeps it useful. The
 * server still decides — a stale page must never be able to perform something by virtue of
 * having rendered the button.
 */
export function availableActions(show: ShowRow, now: Date): AvailableActions {
  const status = show.status.toUpperCase();
  const started = new Date(show.startsAt).getTime() <= now.getTime();

  if (status === 'CANCELLED' || status === 'COMPLETED') {
    return { pause: false, reopen: false, cancel: false, edit: false };
  }
  if (started) {
    // Cancel stays available on a started show: a projector failing ten minutes in is
    // exactly when an operator needs it.
    return { pause: false, reopen: false, cancel: true, edit: false };
  }
  return {
    pause: status === 'SCHEDULED',
    reopen: status === 'PAUSED',
    cancel: true,
    // Offered whatever the booking state; the server refuses with a specific reason if
    // anyone has paid, and that message is more useful than a greyed-out button.
    edit: true,
  };
}

export const occupancyPercent = (show: ShowRow): number | null =>
  show.seatsTotal > 0 ? Math.round((show.seatsSold / show.seatsTotal) * 100) : null;

/**
 * Turn a server rejection into something an operator can act on.
 *
 * The server's reason CODE is preserved by the caller for diagnostics; this is the human
 * sentence. "OVERLAPS_EXISTING_SHOW" tells an operator nothing about which show, or why a
 * gap that looks fine is not.
 */
export function explainRejection(
  r: ScheduleRejection,
  turnaroundMinutes: number,
  timeZone: string,
): string {
  const at = formatLocalTime(r.startsAt, timeZone);
  switch (r.reason) {
    case 'OVERLAPS_EXISTING_SHOW': {
      const gap = r.gapMinutes;
      if (typeof gap === 'number' && gap >= 0) {
        // The subtle one: the shows do not actually overlap, the gap is just too small.
        return `${at} leaves only ${gap} min before or after another show on this screen. Screens need ${turnaroundMinutes} min between shows to empty and clean.`;
      }
      return `${at} overlaps a show already on this screen by ${Math.abs(gap ?? 0)} min.`;
    }
    case 'OVERLAPS_PROPOSED_SHOW':
      return `${at} clashes with another time in this same request. Remove one of them.`;
    case 'DUPLICATE_IN_REQUEST':
      return `${at} is listed twice in this request.`;
    case 'IN_THE_PAST':
      return `${at} has already passed.`;
    case 'ENDS_BEFORE_IT_STARTS':
      return `${at} has an end time before its start.`;
    default:
      return `${at} was rejected (${r.reason}).`;
  }
}

/**
 * A show's start as the CINEMA reads it, in 24-hour time.
 *
 * The timezone is required, not optional. This used to call toLocaleTimeString with no zone,
 * which resolves in the BROWSER's — so the day was fetched for Asia/Kolkata while the rows
 * were rendered in whatever zone the operator's laptop was set to. A 09:00 Hyderabad show
 * displayed as 21:30 the previous evening for anyone outside India, on the same page that
 * had correctly asked for the Hyderabad day.
 *
 * 24-hour because that is how a theater publishes and how the operator typed it in.
 */
export function formatLocalTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Group a flat day into screens, preserving the server's ordering within each. */
export function groupByScreen(
  rows: ShowRow[],
): { screenId: string; screenName: string; shows: ShowRow[] }[] {
  const byScreen = new Map<string, { screenId: string; screenName: string; shows: ShowRow[] }>();
  for (const row of rows) {
    const key = row.screenId ?? 'unassigned';
    if (!byScreen.has(key)) {
      byScreen.set(key, {
        screenId: key,
        screenName: row.screenName ?? 'Unassigned',
        shows: [],
      });
    }
    byScreen.get(key)!.shows.push(row);
  }
  return [...byScreen.values()].sort((a, b) => a.screenName.localeCompare(b.screenName));
}

/** Shift a YYYY-MM-DD label by whole days on the calendar, never by 24h of UTC. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Today's calendar date AT THE CINEMA.
 *
 * The zone is required, not optional. This previously read the browser's calendar, which is
 * the same defect in miniature: an operator in London opening a Hyderabad cinema after 18:30
 * GMT would land on yesterday and see an empty schedule. A caller that does not yet know the
 * venue's zone has no business computing its "today" — it should wait.
 */
export const todayLabel = (timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());

/**
 * A show's start as wall-clock parts in the cinema's zone.
 *
 * Used to prefill the edit dialog. Reading `.getHours()` would give the browser's zone and
 * show a Hyderabad manager in London the wrong current time before they had changed
 * anything.
 */
export function localDateParts(iso: string, timeZone: string): { date: string; time: string } {
  const d = new Date(iso);
  // en-CA yields YYYY-MM-DD, which is what a date input expects.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return { date, time };
}

/**
 * Operator-facing text for a refused mutation.
 *
 * Keyed on `details.reason`, the stable code the API now returns, NOT on the message text —
 * matching English prose would break the first time a sentence is reworded. The server's
 * own message is the fallback, so an unrecognised refusal still says something true rather
 * than "something went wrong".
 */
export function explainMutationError(err: unknown): string {
  // web-kit's ApiRequestError carries code / message / details as own properties.
  const e = (err ?? {}) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  const reason = String(e.details?.reason ?? '');
  const code = String(e.code ?? '');

  switch (reason) {
    case 'SHOW_HAS_CONFIRMED_BOOKINGS':
      return 'This show already has paid bookings and cannot be moved. Cancel the show instead, so customers are told.';
    case 'SHOW_HAS_ACTIVE_CHECKOUTS':
      return 'Someone is part-way through booking this show. Try again once their hold expires.';
    case 'SHOW_HAS_BOOKINGS':
      return 'This show has active seat commitments and cannot be moved to another screen.';
    case 'SHOW_ALREADY_STARTED':
      return 'This show has already started and can no longer be edited.';
    case 'SHOW_ALREADY_COMPLETED':
      return 'This show has finished and can no longer be edited.';
    case 'SHOW_CANCELLED':
      return 'Cancelled shows cannot be edited.';
    case 'SHOW_NOT_PAUSED':
      return 'Only a paused show can be reopened.';
    case 'OVERLAPS_EXISTING_SHOW':
      return 'That time conflicts with another show on this screen. Screens also need time between shows for the audience to leave and the room to be cleaned.';
    default:
      break;
  }

  if (code === 'TENANT_FORBIDDEN' || code === 'FORBIDDEN') {
    return 'You do not have access to modify this show.';
  }
  if (/maintenance|not in service/i.test(String(e.message ?? ''))) {
    return 'This screen is not available for scheduling.';
  }
  // The server's message is written for end users, so it is a safe fallback.
  return String(e.message || 'That change could not be saved. Please try again.');
}

/**
 * The seven local dates of the week containing `date`, Monday first.
 *
 * Walked on the label calendar, never on instants. Deriving week boundaries from the
 * browser would give a Hyderabad cinema a different week to an operator in Sydney, which
 * is the same class of defect already fixed twice on this page.
 */
export function weekDates(date: string): string[] {
  const anchor = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return [];
  // getUTCDay: 0 = Sunday. A theater week reads Monday-first.
  const offsetToMonday = (anchor.getUTCDay() + 6) % 7;
  const monday = new Date(anchor.getTime() - offsetToMonday * 86_400_000);
  return Array.from({ length: 7 }, (_unused, i) =>
    new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** A show's LOCAL calendar date at the cinema, for bucketing a week. */
export function localDateOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));
}

/**
 * "Mon 21 Aug", for a week column heading.
 *
 * Formatted from the label at UTC midday, deliberately: the label already IS the cinema's
 * local date, so re-interpreting it through a zone would shift it back off by one.
 */
export function formatDayHeading(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * Booking-window state for one show, as the OPERATOR needs to read it.
 *
 * Derived from the same fields and the same boundary rule the server enforces: booking
 * creation rejects on `salesStartAt > now` and `salesEndAt < now`, so both edges are
 * INCLUSIVE. An exclusive close reads more naturally and would be wrong — the workspace
 * would say "closed" on a show the server would still happily sell, which is exactly the
 * inconsistency already fixed once on the public side.
 *
 * Sales state outranks the window: a paused or cancelled show is not "waiting to open".
 */
export type BookingWindowState =
  'ON_SALE' | 'SALES_NOT_OPEN' | 'BOOKING_CLOSED' | 'SALES_PAUSED' | 'CANCELLED' | 'FINISHED';

export function bookingWindowState(
  show: { status: string; salesStartAt?: string | null; salesEndAt?: string | null },
  now: Date,
): BookingWindowState {
  const status = show.status.toUpperCase();
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'PAUSED') return 'SALES_PAUSED';
  if (status === 'COMPLETED') return 'FINISHED';

  if (show.salesStartAt && now.getTime() < new Date(show.salesStartAt).getTime()) {
    return 'SALES_NOT_OPEN';
  }
  // `>` not `>=`: the close is inclusive, matching booking creation exactly.
  if (show.salesEndAt && now.getTime() > new Date(show.salesEndAt).getTime()) {
    return 'BOOKING_CLOSED';
  }
  return 'ON_SALE';
}

/** Operator-facing label and explanation for a booking-window state. */
export function describeBookingWindow(
  state: BookingWindowState,
  show: { salesStartAt?: string | null },
  timeZone: string,
): { label: string; tone: ShowTone; hint: string } {
  switch (state) {
    case 'ON_SALE':
      return { label: 'On sale', tone: 'success', hint: 'Customers can book this show.' };
    case 'SALES_NOT_OPEN':
      return {
        label: 'Not open yet',
        tone: 'neutral',
        hint: show.salesStartAt
          ? `Bookings open ${new Intl.DateTimeFormat('en-GB', {
              timeZone,
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).format(new Date(show.salesStartAt))}.`
          : 'Bookings have not opened for this show yet.',
      };
    case 'BOOKING_CLOSED':
      return {
        label: 'Booking closed',
        tone: 'neutral',
        hint: 'Online booking has closed for this show.',
      };
    case 'SALES_PAUSED':
      return {
        label: 'Sales paused',
        tone: 'warning',
        hint: 'Sales were paused manually. Existing tickets are still valid.',
      };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'error', hint: 'This show was cancelled.' };
    case 'FINISHED':
      return { label: 'Finished', tone: 'neutral', hint: 'This show has already played.' };
  }
}

/**
 * The single badge a show row displays.
 *
 * Lifecycle status ("scheduled") and booking window ("closed") answer different questions,
 * and rendering both put rows on screen reading "On sale  Booking closed" — two badges
 * contradicting each other in the same breath. An operator does not need the taxonomy; they
 * need one answer to "is this selling right now, and if not, why".
 *
 * `describeBookingWindow` already folds the lifecycle in, so it is the answer for every
 * status this build knows. A status it does NOT know falls back to rendering itself rather
 * than defaulting to "On sale": when a newer API adds a state, an out-of-date screen must
 * say something honest and unfamiliar, not something confident and wrong.
 */
export function effectiveShowBadge(
  show: { status: string; salesStartAt?: string | null; salesEndAt?: string | null },
  now: Date,
  timeZone: string,
): { label: string; tone: ShowTone; hint: string } {
  const known = ['SCHEDULED', 'PAUSED', 'CANCELLED', 'COMPLETED'];
  if (!known.includes(show.status.toUpperCase())) {
    const fallback = presentShow(show.status);
    return {
      label: fallback.label,
      tone: fallback.tone,
      hint: 'This show is in a state this screen does not recognise.',
    };
  }
  return describeBookingWindow(bookingWindowState(show, now), show, timeZone);
}
