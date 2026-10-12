'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  CalendarDayPanel,
  CalendarMonthGrid,
  IconButton,
  Skeleton,
  type CalendarEntry,
  type OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import {
  addDays,
  addMonths,
  entryFor,
  entriesByDay,
  formatDayLong,
  monthGrid,
  rangeTitle,
  segmentsByDay,
  startOfMonth,
  toCalendarSessions,
  type CalendarSession,
  type WeekStart,
} from '@/lib/calendar';
import type { Selling } from './status';
import { SaleStatePill } from './upcoming-events';
import { showIsOn } from './model';

const NOUN = { one: 'show', many: 'shows' };

/** Rows listed under the month before "Show N more": the card stays the same height. */
export const MONTH_CARD_ROWS = 4;

/**
 * The month at a glance, and one day's shows under it.
 *
 * ── ONE CALENDAR, NOT TWO ───────────────────────────────────────────────────────────
 * This used to be its own table of buttons and its own list of shows. It now draws the Calendar
 * page's components (web-kit's month grid and day panel, in their `compact` form for a narrow
 * column) from the same functions (`@/lib/calendar`): a show is placed on the date AT ITS VENUE,
 * the ring marks the viewer's own today, and a row links to where the show is managed - a film
 * show to its film page. The Overview adds only what it owns: the header, the sale-state pill
 * under each row (the server's answer) and what the "Today" list contains.
 *
 * ── DATES ARE THE VENUE'S, THE RING IS THE VIEWER'S ────────────────────────────────
 * A dot sits under the date a show is on AT ITS VENUE, so a 23:30 show in Hyderabad is never drawn
 * on the next day for a reader in London. The ring marks the viewer's today.
 */
export function MonthCard({
  month,
  onMonth,
  today,
  selected,
  onSelect,
  weekStart,
  shows,
  loading,
  failed,
  onRetry,
  agenda,
  agendaLoading,
  sellingFor,
}: {
  /** Any day of the month shown. */
  month: string;
  onMonth: (next: string) => void;
  /** The viewer's today. */
  today: string;
  /** The chosen day, or null for "Today". */
  selected: string | null;
  onSelect: (day: string | null) => void;
  weekStart: WeekStart;
  /** The month's sessions, as the API sent them. */
  shows: OrganizerCalendarSession[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** The list under the grid: today's shows still to start, or the chosen day's. */
  agenda: OrganizerCalendarSession[];
  agendaLoading: boolean;
  sellingFor: (sessionId: string) => Selling;
}) {
  const router = useRouter();
  const weeks = useMemo(() => monthGrid(month, weekStart), [month, weekStart]);
  const viewerZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const entries = useMemo(() => {
    const live = toCalendarSessions((shows ?? []).filter(showIsOn));
    const byDay = segmentsByDay(live, weeks[0][0], weeks[weeks.length - 1][6]);
    return entriesByDay(byDay, viewerZone);
  }, [shows, weeks, viewerZone]);

  const agendaEntries = useMemo(() => {
    const sessions = toCalendarSessions(agenda);
    // A wide range: the list is already the right shows, this only turns them into rows.
    const from = addDays(selected ?? today, -2);
    const to = addDays(selected ?? today, 2);
    const byDay = segmentsByDay(sessions, from, to);
    const seen = new Set<string>();
    const out: CalendarEntry<CalendarSession>[] = [];
    for (const list of byDay.values())
      for (const seg of list) {
        if (seen.has(seg.session.id)) continue;
        seen.add(seg.session.id);
        const entry = entryFor(seg, viewerZone);
        out.push({
          ...entry,
          extra: <SaleStatePill selling={sellingFor(seg.session.id)} size="sm" />,
        });
      }
    return out.sort((a, b) => a.source.startsAt.localeCompare(b.source.startsAt));
    // `sellingFor` changes when the sale states land, which is when the pills must update.
  }, [agenda, selected, today, viewerZone, sellingFor]);

  const monthKey = startOfMonth(month).slice(0, 7);
  const focusedDay = selected ?? (today.startsWith(monthKey) ? today : startOfMonth(month));
  const agendaDay = selected ?? today;
  const open = (entry: CalendarEntry<CalendarSession>) => {
    if (entry.destination) router.push(entry.destination.href);
  };

  return (
    <div className="min-w-0 space-y-4">
      <section
        aria-labelledby="month-card-title"
        className="min-w-0 rounded-lg border border-border bg-background-surface shadow-xs"
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
          <h2
            id="month-card-title"
            className="font-display text-[1.0625rem] font-bold text-text-primary"
            aria-live="polite"
          >
            {rangeTitle('month', month, weekStart)}
          </h2>
          <div className="flex items-center gap-0.5">
            <IconButton
              label="Previous month"
              icon={ChevronLeft}
              size="sm"
              onClick={() => onMonth(addMonths(startOfMonth(month), -1))}
            />
            <IconButton
              label="Next month"
              icon={ChevronRight}
              size="sm"
              onClick={() => onMonth(addMonths(startOfMonth(month), 1))}
            />
            {(month.slice(0, 7) !== today.slice(0, 7) || selected !== null) && (
              <button
                type="button"
                onClick={() => {
                  onMonth(today);
                  onSelect(null);
                }}
                className="ml-1 rounded-md bg-background-subtle px-2.5 py-1 text-caption font-semibold text-text-primary hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Today
              </button>
            )}
          </div>
        </div>
        <div className="px-2 pb-3 sm:px-3" aria-busy={loading}>
          {failed ? (
            <p className="px-2 py-6 text-center text-caption text-text-muted">
              We could not load your shows.{' '}
              <button
                type="button"
                onClick={onRetry}
                className="rounded-sm font-semibold text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Try again
              </button>
            </p>
          ) : (
            <CalendarMonthGrid
              compact
              weeks={weeks}
              month={monthKey}
              entries={entries}
              today={today}
              focusedDay={focusedDay}
              weekStart={weekStart}
              formatDay={formatDayLong}
              noun={NOUN}
              onFocusDay={(day, viaKeyboard) => {
                if (day.slice(0, 7) !== monthKey) {
                  // An arrow key off the month pages it; a click on a muted day does the same.
                  onMonth(day);
                  onSelect(day === today ? null : day);
                  return;
                }
                if (viaKeyboard || day !== focusedDay) onSelect(day === today ? null : day);
              }}
              onOpen={open}
            />
          )}
        </div>
      </section>

      {agendaLoading ? (
        <div
          className="rounded-lg border border-border bg-background-surface p-5 shadow-xs"
          role="status"
          aria-label="Loading shows"
        >
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-4 h-12 w-full" />
          <Skeleton className="mt-2 h-12 w-full" />
        </div>
      ) : (
        <CalendarDayPanel
          compact
          cap={MONTH_CARD_ROWS}
          day={agendaDay}
          heading={selected === null ? 'Today' : formatDayLong(selected)}
          listLabel={`Shows ${selected === null ? 'today' : `on ${formatDayLong(selected)}`}`}
          entries={agendaEntries}
          today={today}
          noun={NOUN}
          showDayLabel="View all"
          dayNote={
            selected === null
              ? `${formatDayLong(today)}. Shows still to start, at each venue's local time.`
              : "At each venue's local time."
          }
          onOpen={open}
          onShowDay={(day) => router.push(`/organizer/calendar?view=day&date=${day}`)}
        />
      )}
    </div>
  );
}
