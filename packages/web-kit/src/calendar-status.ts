/**
 * The rules both console calendars DRAW by: the status words, their tones, and the keys that
 * move through a month. Pure - no React, no clock - so `calendar-view.spec.tsx` and each app's
 * `lib/calendar.test.ts` can pin them.
 *
 * What a calendar SHOWS (which sessions, in which zone, for whom) stays in each app's
 * `lib/calendar.ts`: the organizer and the admin read different endpoints under different
 * permissions. This file is only how a status looks once an app has decided to show it, so a
 * status reads the same to an organizer and to the admin who reviews them.
 */

/** A calendar date as a label: `YYYY-MM-DD`. Never parsed through the browser's zone. */
export type CalendarDay = string;

/** 0 = Sunday, 1 = Monday. */
export type CalendarWeekStart = 0 | 1;

export type CalendarTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

/**
 * How an event status reads on a calendar: its words and the tone of its dot and pill.
 *
 * The words are the console's lifecycle vocabulary (DESIGN-DIRECTION): "In review", not "Under
 * review"; COMPLETED and ARCHIVED are "Ended". PAUSED and SOLD_OUT keep their own words because
 * they are what the event row says, not a claim about sale eligibility - that comes only from
 * the server's unified eligibility, which a calendar does not read.
 */
const STATUS_LOOK: Record<string, { label: string; tone: CalendarTone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  UNDER_REVIEW: { label: 'In review', tone: 'warning' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  SOLD_OUT: { label: 'Sold out', tone: 'info' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  COMPLETED: { label: 'Ended', tone: 'neutral' },
  ARCHIVED: { label: 'Ended', tone: 'neutral' },
};

/** "In review", for a filter option, a pill or a status line. */
export function calendarStatusText(status: string): string {
  const known = STATUS_LOOK[status];
  if (known) return known.label;
  const words = status.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The tone a status is drawn in. A status this table does not know is neutral, never green. */
export function calendarStatusTone(status: string): CalendarTone {
  return STATUS_LOOK[status]?.tone ?? 'neutral';
}

/**
 * The status a session is DRAWN with, and its words.
 *
 * The event's status, unless the session itself was cancelled or paused: a cancelled 21:00 show
 * inside a published event must not look like it is on sale. `noun` is what the console calls a
 * session - "Session cancelled" to an organizer, "Show cancelled" to an admin.
 */
export function calendarDisplayStatus(
  eventStatus: string,
  sessionStatus: string,
  noun: 'Session' | 'Show',
): { status: string; label: string } {
  if (sessionStatus === 'CANCELLED' || sessionStatus === 'PAUSED') {
    return { status: sessionStatus, label: `${noun} ${sessionStatus.toLowerCase()}` };
  }
  return { status: eventStatus, label: calendarStatusText(eventStatus) };
}

/**
 * The dot beside a session, in its status colour, and the rule down the left of a block in a
 * time grid. Never the only carrier of the status: every chip names it in words or in its
 * accessible name. Only semantic tokens, whose pairs `token-contrast.test.ts` asserts.
 */
export const CALENDAR_DOT: Record<CalendarTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

export const CALENDAR_RULE: Record<CalendarTone, string> = {
  success: 'border-l-status-success',
  warning: 'border-l-status-warning',
  error: 'border-l-status-error',
  info: 'border-l-status-info',
  neutral: 'border-l-text-muted',
};

// ─── Day labels, for moving through a month ───

const DAY_MS = 86_400_000;

/** `n` days on from a label. Done at UTC midnight, where no day is 23 or 25 hours long. */
export function calendarAddDays(day: CalendarDay, n: number): CalendarDay {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** The first day of the week holding `day`. */
export function calendarStartOfWeek(day: CalendarDay, weekStart: CalendarWeekStart): CalendarDay {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return calendarAddDays(day, -((dow - weekStart + 7) % 7));
}

/**
 * Which day a keyboard key moves focus to in a month grid, or null for a key it ignores.
 * Arrows move by a day or a week; Home and End go to the ends of the focused day's week.
 */
export function calendarFocusTarget(
  day: CalendarDay,
  key: string,
  weekStart: CalendarWeekStart,
): CalendarDay | null {
  switch (key) {
    case 'ArrowLeft':
      return calendarAddDays(day, -1);
    case 'ArrowRight':
      return calendarAddDays(day, 1);
    case 'ArrowUp':
      return calendarAddDays(day, -7);
    case 'ArrowDown':
      return calendarAddDays(day, 7);
    case 'Home':
      return calendarStartOfWeek(day, weekStart);
    case 'End':
      return calendarAddDays(calendarStartOfWeek(day, weekStart), 6);
    default:
      return null;
  }
}

/** The weekday headings a month grid draws, starting on `weekStart`. */
export function calendarWeekdayNames(weekStart: CalendarWeekStart): string[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Array.from({ length: 7 }, (_, i) => names[(i + weekStart) % 7]);
}
