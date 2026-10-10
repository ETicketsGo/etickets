'use client';

import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  IconButton,
  SectionLink,
  Skeleton,
  type OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import {
  addMonths,
  formatClock,
  formatDayLong,
  monthGrid,
  rangeTitle,
  sessionZone,
  startOfMonth,
  type WeekStart,
} from '@/lib/calendar';
import { zoneShortName } from '@/components/events/event-list-model';
import type { Selling } from './status';
import { SaleStatePill } from './upcoming-events';

const WEEKDAY = (day: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(`${day}T12:00:00Z`),
  );

/** How many dots a day gets: one, two or three - a hint of how busy, the number is in its name. */
function dots(n: number): number {
  return n <= 0 ? 0 : n === 1 ? 1 : n <= 4 ? 2 : 3;
}

/**
 * The month at a glance, and one day's shows under it - the reference's calendar card.
 *
 * ── DATES ARE THE VENUE'S, THE RING IS THE VIEWER'S ────────────────────────────────
 * A dot sits under the date a show is on AT ITS VENUE (the calendar page's rule), so a 23:30
 * show in Hyderabad is never drawn on the next day for a reader in London. The ring marks the
 * viewer's own today: that is the day they are living in.
 *
 * Choosing a day lists its shows below; the agenda starts on "Today", where today is the date
 * at each show's venue. Every day is a real button with its date and count as its name.
 */
export function MonthCard({
  month,
  onMonth,
  today,
  selected,
  onSelect,
  weekStart,
  perDay,
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
  perDay: Map<string, number>;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  agenda: OrganizerCalendarSession[];
  agendaLoading: boolean;
  sellingFor: (sessionId: string) => Selling;
}) {
  const weeks = monthGrid(month, weekStart);
  const monthKey = startOfMonth(month).slice(0, 7);
  const AGENDA_LIMIT = 4;
  const shown = agenda.slice(0, AGENDA_LIMIT);
  const hidden = agenda.length - shown.length;
  const agendaDay = selected ?? today;
  const agendaTitle = selected === null ? 'Today' : formatDayLong(selected);
  return (
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

      <div className="px-3 sm:px-4">
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
          <table className="w-full table-fixed border-collapse text-center" aria-busy={loading}>
            <caption className="sr-only">
              Shows by date in {rangeTitle('month', month, weekStart)}. Choose a date to list its
              shows.
            </caption>
            <thead>
              <tr>
                {weeks[0].map((d) => (
                  <th
                    key={d}
                    scope="col"
                    abbr={WEEKDAY(d)}
                    className="pb-1 text-micro font-medium text-text-muted"
                  >
                    {WEEKDAY(d).slice(0, 2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]}>
                  {week.map((d) => {
                    const inMonth = d.slice(0, 7) === monthKey;
                    const count = perDay.get(d) ?? 0;
                    const isToday = d === today;
                    const isSelected = d === agendaDay;
                    const name = `${formatDayLong(d)}${isToday ? ', today' : ''}: ${
                      loading
                        ? 'loading'
                        : count === 0
                          ? 'no shows'
                          : `${count} ${count === 1 ? 'show' : 'shows'}`
                    }`;
                    return (
                      <td key={d} className="p-0.5">
                        <button
                          type="button"
                          aria-label={name}
                          aria-pressed={isSelected}
                          onClick={() => onSelect(isToday ? null : d)}
                          className={`relative mx-auto flex h-10 w-full max-w-[2.75rem] flex-col items-center justify-center rounded-full text-[0.8125rem] tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                            isToday
                              ? 'bg-action-primary font-bold text-action-primary-foreground'
                              : isSelected
                                ? 'bg-tint-primary font-semibold text-action-primary ring-1 ring-action-primary'
                                : inMonth
                                  ? 'font-medium text-text-primary hover:bg-background-subtle'
                                  : 'text-text-muted hover:bg-background-subtle'
                          }`}
                        >
                          <span className="leading-none">{Number(d.slice(8))}</span>
                          <span aria-hidden className="mt-1 flex h-1 gap-0.5">
                            {Array.from({ length: dots(count) }).map((_, i) => (
                              <span
                                key={i}
                                className={`h-1 w-1 rounded-full ${isToday ? 'bg-action-primary-foreground' : 'bg-action-primary'}`}
                              />
                            ))}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-2 border-t border-border px-5 pb-4 pt-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui font-semibold text-text-primary">
            {agendaTitle}
            {selected === null && (
              <span className="font-normal text-text-muted"> - {formatDayLong(today)}</span>
            )}
          </h3>
          <SectionLink
            href={`/organizer/calendar?view=day&date=${agendaDay}`}
            srLabel="shows that day"
          >
            View all
          </SectionLink>
        </div>
        {agendaLoading ? (
          <div className="mt-3 space-y-3" role="status" aria-label="Loading shows">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : shown.length === 0 ? (
          <p className="mt-2 text-caption text-text-muted">
            {selected === null ? 'No more shows today.' : 'No shows on this date.'}
          </p>
        ) : (
          <ul
            className="mt-2 space-y-1"
            aria-label={`Shows ${selected === null ? 'today' : `on ${formatDayLong(selected)}`}`}
          >
            {shown.map((s) => {
              const { zone } = sessionZone(s);
              return (
                <li key={s.id} className="flex min-w-0 items-start gap-3 rounded-md py-2">
                  <span
                    aria-hidden
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-action-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/organizer/events/${s.event.id}`}
                      className="block truncate rounded-sm text-ui font-semibold text-text-primary hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={s.event.title}
                    >
                      {s.event.title}
                    </Link>
                    <p className="truncate text-micro text-text-muted">
                      <span className="tabular-nums">
                        {formatClock(s.startsAt, zone)} - {formatClock(s.endsAt, zone)}
                      </span>{' '}
                      {zoneShortName(s.startsAt, zone)} · {s.venue.name}
                    </p>
                    <div className="mt-1.5">
                      <SaleStatePill selling={sellingFor(s.id)} size="sm" />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && (
          <Link
            href={`/organizer/calendar?view=day&date=${agendaDay}`}
            className="mt-1 inline-block rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {hidden} more {hidden === 1 ? 'show' : 'shows'}
          </Link>
        )}
      </div>
    </section>
  );
}
