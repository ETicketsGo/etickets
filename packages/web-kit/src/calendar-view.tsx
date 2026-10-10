'use client';

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Skeleton } from './components';
import { IconButton, IconTile, StatusPill } from './primitives';
import {
  CALENDAR_DOT,
  calendarFocusTarget,
  calendarStatusText,
  calendarStatusTone,
  calendarWeekdayNames,
  type CalendarDay,
  type CalendarTone,
  type CalendarWeekStart,
} from './calendar-status';

/**
 * How BOTH console calendars look: the month grid, the day panel beside it, the day cards of the
 * agenda, the chip and the row a session is drawn as, the controls card and the quick look.
 *
 * ── WHAT STAYS IN EACH APP ─────────────────────────────────────────────────────────
 * Which sessions exist and who may see them, the API query, the filters and the URL, the zone a
 * session is placed in, the date words, and what the quick look offers to DO (an organizer opens
 * the event's sessions; an admin opens the organizer). Each app turns its sessions into
 * `CalendarEntry` objects - words already resolved at the venue's clock - and these components
 * only draw them. That way the two consoles cannot drift apart in looks, and neither can borrow
 * the other's authorization by sharing a hook.
 *
 * ── RULES THESE COMPONENTS KEEP ────────────────────────────────────────────────────
 * - Exactly one month cell carries `aria-current="date"`: ONE grid at every width. A phone
 *   shows dots where wider screens show chips; two grids swapped by breakpoint would mark today
 *   twice.
 * - The month is a keyboard grid with a roving tabindex: arrows by day and week, Home/End to
 *   the week's ends, Enter opens the day's first session, and an arrow off the month asks the
 *   page to move (`onFocusDay(day, true)`).
 * - Status is words AND colour, never colour alone: every chip names it in its accessible name
 *   and every row prints it as a pill.
 */

/** One session as a calendar draws it. Every string is already in the venue's clock. */
export interface CalendarEntry<T = unknown> {
  /** Unique; keys the chip and is written to `data-session-id` for focus return and tests. */
  id: string;
  title: string;
  /** The start for a chip: "19:00", "7:30 PM", or "cont." for a day it runs on into. */
  start: string;
  /** The time for a row, with the zone: "19:00 - 22:00 IST". */
  time: string;
  /** The line under the time in a row: "Venue, City", or "Organizer - City". */
  detail?: string;
  tone: CalendarTone;
  /** The status in words: "Published", "Session cancelled". */
  statusLabel: string;
  /** Drawn struck through: a cancelled session. */
  struck?: boolean;
  /** One accessible name with the time and zone, title, place and status. */
  label: string;
  /** The app's own session, handed back on open. */
  source: T;
}

export type OpenCalendarEntry<T> = (entry: CalendarEntry<T>, trigger: HTMLElement) => void;

/** What a console calls a session: "session" to an organizer, "show" to an admin. */
export interface CalendarNoun {
  one: string;
  many: string;
}

export function calendarCount(n: number, noun: CalendarNoun): string {
  return `${n} ${n === 1 ? noun.one : noun.many}`;
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const LINK = `rounded-sm text-caption font-semibold text-action-primary hover:underline ${FOCUS}`;

// ─── Small pieces ───

/** "Today" beside a day heading, as a pill. */
export function CalendarTodayPill() {
  return (
    <StatusPill tone="primary" size="sm">
      Today
    </StatusPill>
  );
}

/** "Today" in a dense column heading: the same teal ring the month draws round today's date. */
export function CalendarTodayBadge() {
  return (
    <span className="rounded-full bg-tint-primary px-2 py-0.5 text-[0.6875rem] font-semibold text-action-primary ring-1 ring-action-primary">
      Today
    </span>
  );
}

/**
 * The line that says whose "today" is ringed. The policy is shared-types' `viewer-today.ts`: the
 * reader's own date, in the zone their browser reports - while every session sits on the date AT
 * ITS VENUE. Saying both stops a ringed date and a session's date looking like a contradiction.
 */
export function CalendarZoneNote({ zone, extra }: { zone: string; extra?: string }) {
  return (
    <p data-testid="calendar-today-zone">
      Today is marked in your time zone, {zone}.{extra ? ` ${extra}` : ''}
    </p>
  );
}

/** The status pill a row ends with: the words, wrapping rather than cut off. */
function EntryPill({ entry }: { entry: CalendarEntry<unknown> }) {
  return (
    <StatusPill tone={entry.tone} size="sm" dot={false}>
      {entry.statusLabel}
    </StatusPill>
  );
}

/**
 * A session in a month cell or a dense column: status dot and time, the title under them.
 *
 * Quiet by design. A busy month is a wall of these, and thirty tinted boxes read as noise; a dot
 * and a line of text scan like the reference's calendar card. The title is cut to the cell - the
 * one place a calendar truncates - because the full words are in the accessible name, the hover
 * title, and the day panel or agenda one click away.
 */
export function CalendarChip<T>({
  entry,
  onOpen,
  tabbable = true,
}: {
  entry: CalendarEntry<T>;
  onOpen: OpenCalendarEntry<T>;
  /** Out of the tab order unless its day is the grid's focused one. */
  tabbable?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      data-session-id={entry.id}
      aria-label={entry.label}
      title={entry.label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(entry, e.currentTarget);
      }}
      className={`block w-full min-w-0 rounded-md px-1.5 py-0.5 text-left text-micro leading-[1.125rem] text-text-primary transition-colors duration-150 hover:bg-background-subtle ${FOCUS}`}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${CALENDAR_DOT[entry.tone]}`} />
        <span className="font-semibold tabular-nums">{entry.start}</span>
      </span>
      {/* The title on its own line: beside the time, a month cell leaves it a few letters. */}
      <span
        className={`block truncate pl-3.5 text-text-secondary ${entry.struck ? 'line-through' : ''}`}
      >
        {entry.title}
      </span>
    </button>
  );
}

/**
 * A session as a row: the day panel, the agenda, and a week on a narrow screen. Dot, title, time
 * at the venue, place, and the status in words. Nothing here is cut off: a row has the width to
 * wrap, and a calendar must never hide what a session is.
 */
export function CalendarRow<T>({
  entry,
  onOpen,
  inset = false,
}: {
  entry: CalendarEntry<T>;
  onOpen: OpenCalendarEntry<T>;
  /** Inside a padded panel, rather than edge to edge in a card. */
  inset?: boolean;
}) {
  return (
    <button
      type="button"
      data-session-id={entry.id}
      aria-label={entry.label}
      onClick={(e) => onOpen(entry, e.currentTarget)}
      className={`flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 text-left transition-colors duration-150 hover:bg-background-subtle ${FOCUS} ${
        inset ? 'rounded-md px-3 py-2.5' : 'px-4 py-3 focus-visible:ring-inset'
      }`}
    >
      <span
        aria-hidden
        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${CALENDAR_DOT[entry.tone]}`}
      />
      <span className="min-w-0 flex-1 basis-40">
        <span
          className={`block break-words text-sm font-semibold text-text-primary [overflow-wrap:anywhere] ${entry.struck ? 'line-through' : ''}`}
        >
          {entry.title}
        </span>
        <span className="block text-caption tabular-nums text-text-secondary">{entry.time}</span>
        {entry.detail && (
          <span className="block break-words text-caption text-text-muted">{entry.detail}</span>
        )}
      </span>
      <EntryPill entry={entry} />
    </button>
  );
}

// ─── The month ───

/** Chips drawn in one day cell before "+N more"; a busy cinema day can hold forty shows. */
export const CALENDAR_MONTH_CELL_CAP = 3;
/** Dots under a day on a phone, where a cell is too narrow for a title. */
const DOT_CAP = 4;

/**
 * A month as a keyboard grid. See the file comment for the keyboard and `aria-current` rules.
 * Chips in cells other than the focused one stay out of the tab order, or a month would be
 * several hundred tab stops; Tab from the focused day reaches its sessions.
 */
export function CalendarMonthGrid<T>({
  weeks,
  month,
  entries,
  today,
  focusedDay,
  weekStart,
  formatDay,
  noun,
  showDayLabel,
  onFocusDay,
  onOpen,
  onShowDay,
}: {
  weeks: CalendarDay[][];
  /** `YYYY-MM` of the month being shown; days outside it are drawn muted. */
  month: string;
  entries: ReadonlyMap<CalendarDay, CalendarEntry<T>[]>;
  today: CalendarDay;
  focusedDay: CalendarDay;
  weekStart: CalendarWeekStart;
  /** The day in words, for a cell's accessible name: "Fri, 6 Nov 2026". */
  formatDay: (day: CalendarDay) => string;
  noun: CalendarNoun;
  /** What "+N more" does, in words: "Open the day". */
  showDayLabel: string;
  /** `viaKeyboard` is false for a click: only an arrow key off the month should page it. */
  onFocusDay: (day: CalendarDay, viaKeyboard: boolean) => void;
  onOpen: OpenCalendarEntry<T>;
  onShowDay: (day: CalendarDay) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  // Only move DOM focus after a key press in the grid, never on first render or a toolbar click.
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-day="${focusedDay}"]`);
    if (cell) {
      cell.focus();
      moveFocus.current = false;
    }
  }, [focusedDay, weeks]);

  const onKeyDown = (day: CalendarDay, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const first = entries.get(day)?.[0];
      if (first) {
        e.preventDefault();
        onOpen(first, e.currentTarget);
      }
      return;
    }
    const next = calendarFocusTarget(day, e.key, weekStart);
    if (!next) return;
    e.preventDefault();
    moveFocus.current = true;
    onFocusDay(next, true);
  };

  return (
    <div ref={gridRef} role="grid" aria-label="Month" className="min-w-0">
      <div role="row" className="grid grid-cols-7 border-b border-border">
        {calendarWeekdayNames(weekStart).map((n) => (
          <div
            key={n}
            role="columnheader"
            className="px-1 pb-2 text-center text-micro font-semibold uppercase tracking-wide text-text-muted sm:px-2 sm:text-left"
          >
            {n}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div
          key={week[0]}
          role="row"
          className="grid grid-cols-7 border-b border-border last:border-b-0"
        >
          {week.map((day) => {
            const list = entries.get(day) ?? [];
            const shown = list.slice(0, CALENDAR_MONTH_CELL_CAP);
            const hidden = list.length - shown.length;
            const inMonth = day.startsWith(month);
            const isToday = day === today;
            const isFocused = day === focusedDay;
            return (
              <div
                key={day}
                role="gridcell"
                data-day={day}
                data-testid={`month-day-${day}`}
                aria-current={isToday ? 'date' : undefined}
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isFocused}
                aria-label={`${formatDay(day)}${isToday ? ', today' : ''}, ${
                  list.length === 0 ? `no ${noun.many}` : calendarCount(list.length, noun)
                }`}
                onKeyDown={(e) => onKeyDown(day, e)}
                // A click focuses the cell too (it is focusable), so this also answers the pointer.
                onFocus={(e) => {
                  if (e.target === e.currentTarget && !isFocused) onFocusDay(day, false);
                }}
                className={`min-h-[3.5rem] min-w-0 cursor-pointer border-r border-border p-1 transition-colors duration-150 last:border-r-0 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-[7.25rem] sm:p-1.5 ${
                  isFocused ? 'bg-background-subtle' : inMonth ? '' : 'bg-background-canvas/60'
                }`}
              >
                <div className="mb-1 flex justify-center sm:justify-start">
                  <span
                    aria-hidden
                    className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-caption tabular-nums ${
                      isToday
                        ? 'bg-tint-primary font-bold text-action-primary ring-2 ring-action-primary'
                        : inMonth
                          ? 'font-medium text-text-primary'
                          : 'text-text-muted'
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>
                </div>
                {/* Phones: a dot per session, in its status colour, under the date. */}
                {list.length > 0 && (
                  <div aria-hidden className="flex items-center justify-center gap-0.5 sm:hidden">
                    {list.slice(0, DOT_CAP).map((entry) => (
                      <span
                        key={entry.id}
                        className={`h-1.5 w-1.5 rounded-full ${CALENDAR_DOT[entry.tone]}`}
                      />
                    ))}
                    {list.length > DOT_CAP && (
                      <span className="text-[0.625rem] font-semibold leading-none text-text-muted">
                        +
                      </span>
                    )}
                  </div>
                )}
                <div className="hidden space-y-0.5 sm:block">
                  {shown.map((entry) => (
                    <CalendarChip
                      key={entry.id}
                      entry={entry}
                      onOpen={onOpen}
                      tabbable={isFocused}
                    />
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      tabIndex={isFocused ? 0 : -1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowDay(day);
                      }}
                      aria-label={`${hidden} more on ${formatDay(day)}. ${showDayLabel}`}
                      className={`w-full rounded-md px-1.5 text-left text-micro font-semibold text-action-primary hover:underline ${FOCUS}`}
                    >
                      +{hidden} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Rows listed in the day panel before "N more"; the day's own view lists every one. */
export const CALENDAR_PANEL_CAP = 8;

/**
 * The chosen day beside the month: the reference's "Today" agenda card. The month answers "where
 * is it busy"; this answers "what is on that day" without opening anything. On a phone, where a
 * cell shows only dots, it is how a day is read at all.
 */
export function CalendarDayPanel<T>({
  day,
  heading,
  entries,
  today,
  noun,
  showDayLabel,
  onOpen,
  onShowDay,
}: {
  day: CalendarDay;
  /** The day in words: "Fri, 6 Nov 2026". */
  heading: string;
  entries: CalendarEntry<T>[];
  today: CalendarDay;
  noun: CalendarNoun;
  /** "Open the day", "Open in agenda". */
  showDayLabel: string;
  onOpen: OpenCalendarEntry<T>;
  onShowDay: (day: CalendarDay) => void;
}) {
  const shown = entries.slice(0, CALENDAR_PANEL_CAP);
  const hidden = entries.length - shown.length;
  return (
    <section
      aria-labelledby="calendar-day-panel"
      data-testid="calendar-day-panel"
      className="min-w-0 rounded-lg border border-border bg-background-surface shadow-xs xl:sticky xl:top-20"
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0">
          <h2
            id="calendar-day-panel"
            aria-live="polite"
            className="font-display text-[1.0625rem] font-bold text-text-primary"
          >
            {heading}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-caption text-text-muted">
            {day === today && <CalendarTodayPill />}
            {entries.length === 0
              ? 'Nothing scheduled'
              : `${calendarCount(entries.length, noun)}, at venue time`}
          </p>
        </div>
        {entries.length > 0 && (
          <button type="button" onClick={() => onShowDay(day)} className={`shrink-0 ${LINK}`}>
            {showDayLabel}
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-text-secondary">
          No {noun.many} on this day. Pick another day in the month.
        </p>
      ) : (
        <ul className="px-2 pb-3 md:grid md:grid-cols-2 md:gap-x-2 xl:block">
          {shown.map((entry) => (
            <li key={entry.id}>
              <CalendarRow entry={entry} onOpen={onOpen} inset />
            </li>
          ))}
          {hidden > 0 && (
            <li className="px-3 pt-1 md:col-span-2">
              <button type="button" onClick={() => onShowDay(day)} className={LINK}>
                {hidden} more on this day
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * A day as a card of rows: the agenda, and a week on a screen too narrow for columns. Past `cap`
 * rows a "Show N more" button lists the rest in place, so a forty-show cinema Saturday does not
 * push the rest of the fortnight off the page.
 */
export function CalendarDayCard<T>({
  day,
  heading,
  entries,
  today,
  noun,
  onOpen,
  cap,
  expanded = false,
  onExpand,
  headingId = `calendar-day-${day}`,
  testId,
}: {
  day: CalendarDay;
  heading: string;
  entries: CalendarEntry<T>[];
  today: CalendarDay;
  noun: CalendarNoun;
  onOpen: OpenCalendarEntry<T>;
  /** Rows before "Show N more"; omit to list every one. */
  cap?: number;
  expanded?: boolean;
  onExpand?: (day: CalendarDay) => void;
  headingId?: string;
  testId?: string;
}) {
  const limit = expanded || cap === undefined ? entries.length : cap;
  const shown = entries.slice(0, limit);
  const hidden = entries.length - shown.length;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs"
    >
      <h3
        id={headingId}
        tabIndex={-1}
        className="flex scroll-mt-20 flex-wrap items-center gap-2 border-b border-border px-4 py-3 font-display text-ui font-bold text-text-primary focus:outline-none"
      >
        {heading}
        {day === today && <CalendarTodayPill />}
        <span className="ml-auto text-caption font-medium text-text-muted">
          {calendarCount(entries.length, noun)}
        </span>
      </h3>
      {entries.length === 0 ? (
        <p className="px-4 py-3 text-caption text-text-muted">No {noun.many}</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((entry) => (
            <li key={entry.id}>
              <CalendarRow entry={entry} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && onExpand && (
        <div className="border-t border-border px-4 py-2.5">
          <button type="button" onClick={() => onExpand(day)} className={LINK}>
            Show {hidden} more on {heading}
          </button>
        </div>
      )}
    </section>
  );
}

// ─── The page around them ───

export interface CalendarViewOption<V extends string> {
  id: V;
  label: string;
}

/**
 * The controls card: where you are (Previous, the range, Next, Today), how you look at it (the
 * view switch), and what is shown (the app's own filters, folded behind one button on a phone,
 * where four filters were a screen of form before the first date). `children` are the status
 * lines under the filters - counts, the zone note, warnings - which each app words for itself.
 */
export function CalendarToolbar<V extends string>({
  views,
  view,
  onView,
  stepName,
  onStep,
  title,
  titleTestId,
  onToday,
  filters,
  activeFilters,
  filtersLabel = 'Filters',
  children,
}: {
  views: CalendarViewOption<V>[];
  view: V;
  onView: (view: V) => void;
  /** "month", "week", "two weeks": Previous and Next say how far they go. */
  stepName: string;
  onStep: (direction: -1 | 1) => void;
  title: string;
  titleTestId?: string;
  onToday: () => void;
  /** The app's filter fields, laid out by the app. */
  filters: ReactNode;
  activeFilters: number;
  /** The phone's fold button when no filter is on. */
  filtersLabel?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label="Calendar controls"
      className="rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="flex items-center gap-1">
          <IconButton
            variant="outline"
            size="sm"
            icon={ChevronLeft}
            label={`Previous ${stepName}`}
            onClick={() => onStep(-1)}
          />
          <IconButton
            variant="outline"
            size="sm"
            icon={ChevronRight}
            label={`Next ${stepName}`}
            onClick={() => onStep(1)}
          />
        </div>
        <h2
          className="min-w-0 flex-1 font-display text-title font-bold text-text-primary"
          aria-live="polite"
          data-testid={titleTestId}
        >
          {title}
        </h2>
        <Button variant="outline" size="sm" onClick={onToday}>
          Today
        </Button>
        <div
          role="group"
          aria-label="Calendar view"
          className="inline-flex max-w-full rounded-md border border-border bg-background-subtle p-1"
        >
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => onView(v.id)}
              className={`rounded-sm px-3 py-1.5 text-caption font-semibold transition-colors duration-150 ${FOCUS} ${
                view === v.id
                  ? 'bg-background-surface text-action-primary shadow-xs'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        aria-expanded={open}
        aria-controls="calendar-filters"
        onClick={() => setOpen((o) => !o)}
        className={`mt-4 inline-flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-caption font-semibold text-text-primary sm:hidden ${FOCUS}`}
      >
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-text-secondary" aria-hidden />
          {activeFilters > 0 ? `Filters, ${activeFilters} on` : filtersLabel}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      <div
        id="calendar-filters"
        className={`mt-4 border-border sm:block sm:border-t sm:pt-4 ${open ? 'block' : 'hidden'}`}
      >
        {filters}
      </div>

      {children}
    </section>
  );
}

/** The month beside its day panel: side by side from `xl`, the panel under the grid below. */
export function CalendarMonthLayout({ grid, panel }: { grid: ReactNode; panel: ReactNode }) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 rounded-lg border border-border bg-background-surface p-2 shadow-xs sm:p-3">
        {grid}
      </div>
      {panel}
    </div>
  );
}

/** A skeleton shaped like the body: the grid, and the panel beside a month. */
export function CalendarLoading({ withPanel }: { withPanel: boolean }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <Skeleton className="h-[32rem] w-full rounded-lg" />
      {withPanel && <Skeleton className="hidden h-72 w-full rounded-lg xl:block" />}
    </div>
  );
}

// ─── The quick look ───

/** One fact with its icon tile, as the reference's event card lays out date and venue. */
export function CalendarFact({
  icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <IconTile icon={icon} tone="neutral" size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium text-text-secondary">{label}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * The body of the quick-look drawer: the category, the event's status and - when it says
 * something the event's does not - the session's own, then the facts in a tinted box. The drawer
 * and its footer stay in each app, because what you can DO next is the console's business.
 */
export function CalendarPreview({
  category,
  eventStatus,
  shown,
  headingRef,
  children,
}: {
  category: string;
  eventStatus: string;
  /** The status the session is drawn with (`calendarDisplayStatus`). */
  shown: { status: string; label: string };
  /** Focus lands here when the drawer opens, so a keyboard user starts at the top. */
  headingRef?: RefObject<HTMLParagraphElement>;
  /** `CalendarFact`s. */
  children: ReactNode;
}) {
  return (
    <div className="space-y-5 text-ui" data-testid="calendar-preview">
      <div className="space-y-3">
        <p
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="text-micro font-semibold uppercase tracking-wide text-text-muted focus:outline-none"
        >
          {category}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={calendarStatusTone(eventStatus)}>
            Event: {calendarStatusText(eventStatus)}
          </StatusPill>
          {shown.status !== eventStatus && (
            <StatusPill tone={calendarStatusTone(shown.status)}>{shown.label}</StatusPill>
          )}
        </div>
      </div>
      <div className="space-y-4 rounded-lg border border-border bg-background-canvas p-4">
        {children}
      </div>
    </div>
  );
}
