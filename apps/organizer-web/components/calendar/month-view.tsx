'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
  capItems,
  focusTarget,
  formatDayLong,
  type DayKey,
  type DaySegment,
  type WeekStart,
} from '@/lib/calendar';
import { SessionChip, type OpenSession } from './session-chip';

/** Chips drawn in one day cell before "+N more"; a busy cinema day can hold forty shows. */
export const MONTH_CELL_CAP = 3;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A month as a keyboard grid.
 *
 * One day cell is in the tab order at a time (a roving tabindex): arrows move between days,
 * Home/End to the ends of the week, and an arrow off the edge of the month pages the month,
 * through `onFocusDay`, which the page answers by moving the anchor. Enter on a day opens its
 * first session; Tab from the focused day reaches the rest of that day's sessions. Chips in
 * other cells stay out of the tab order, or a month would be several hundred tab stops.
 */
export function MonthView({
  weeks,
  month,
  byDay,
  today,
  focusedDay,
  weekStart,
  onFocusDay,
  onOpen,
  onShowDay,
}: {
  weeks: DayKey[][];
  /** `YYYY-MM` of the month being shown; days outside it are drawn muted. */
  month: string;
  byDay: Map<DayKey, DaySegment[]>;
  today: DayKey;
  focusedDay: DayKey;
  weekStart: WeekStart;
  /** `viaKeyboard` is false for a click: only an arrow key off the month should page it. */
  onFocusDay: (day: DayKey, viaKeyboard: boolean) => void;
  onOpen: OpenSession;
  onShowDay: (day: DayKey) => void;
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

  const onKeyDown = (day: DayKey, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const first = byDay.get(day)?.[0];
      if (first) {
        e.preventDefault();
        onOpen(first.session, e.currentTarget);
      }
      return;
    }
    const next = focusTarget(day, e.key, weekStart);
    if (!next) return;
    e.preventDefault();
    moveFocus.current = true;
    onFocusDay(next, true);
  };

  const names = Array.from({ length: 7 }, (_, i) => WEEKDAY_NAMES[(i + weekStart) % 7]);

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Month"
      className="overflow-hidden rounded-lg border border-border bg-background-surface"
    >
      <div role="row" className="grid grid-cols-7 border-b border-border bg-background-subtle">
        {names.map((n) => (
          <div
            key={n}
            role="columnheader"
            className="px-1 py-2 text-center text-caption font-medium text-text-secondary sm:px-2 sm:text-left"
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
            const segments = byDay.get(day) ?? [];
            const { shown, hidden } = capItems(segments, MONTH_CELL_CAP);
            const inMonth = day.startsWith(month);
            const isToday = day === today;
            const isFocused = day === focusedDay;
            const count = segments.length;
            return (
              <div
                key={day}
                role="gridcell"
                data-day={day}
                data-testid={`month-day-${day}`}
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isFocused}
                aria-label={`${formatDayLong(day)}${isToday ? ', today' : ''}, ${
                  count === 0 ? 'no sessions' : count === 1 ? '1 session' : `${count} sessions`
                }`}
                onKeyDown={(e) => onKeyDown(day, e)}
                onFocus={(e) => {
                  if (e.target === e.currentTarget && !isFocused) onFocusDay(day, false);
                }}
                className={`min-h-[5.5rem] min-w-0 border-r border-border p-1 last:border-r-0 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-[7.5rem] sm:p-1.5 ${
                  inMonth ? '' : 'bg-background-canvas'
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    aria-hidden
                    className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-caption tabular-nums ${
                      isToday
                        ? 'bg-action-primary font-semibold text-action-primary-foreground'
                        : inMonth
                          ? 'text-text-primary'
                          : 'text-text-muted'
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {shown.map((seg) => (
                    <SessionChip
                      key={seg.session.id}
                      segment={seg}
                      onOpen={onOpen}
                      tabbable={isFocused}
                    />
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      tabIndex={isFocused ? 0 : -1}
                      onClick={() => onShowDay(day)}
                      aria-label={`${hidden} more on ${formatDayLong(day)}. Open the day`}
                      className="w-full rounded px-1 text-left text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
