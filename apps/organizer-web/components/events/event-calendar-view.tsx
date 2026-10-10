'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, MapPin } from 'lucide-react';
import {
  api,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Skeleton,
  type OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import { EventStateBadges } from './event-state-badges';
import { zoneShortName } from './event-list-model';
import {
  monthCells,
  monthKeyOf,
  monthRange,
  monthTitle,
  sessionZone,
  sessionsByDay,
  shiftMonth,
} from './event-calendar-model';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "7:30 pm IST" - the time at the venue, with its zone, as everywhere else in the console. */
function timeOf(s: OrganizerCalendarSession): string {
  const zone = sessionZone(s);
  const time = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  }).format(new Date(s.startsAt));
  const abbrev = zone ? zoneShortName(s.startsAt, zone) : '';
  return abbrev ? `${time} ${abbrev}` : `${time} (your time)`;
}

/** "Fri, 9 Oct 2026" for a YYYY-MM-DD day. */
function dayTitle(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/**
 * The events by date: a month with a dot under every day that has a show, and that day's
 * shows beside it - the reference's calendar card, for the events the list's filters kept.
 *
 * Every show of the month comes from the organizer calendar endpoint (one request per month),
 * so a run of twenty shows draws twenty days, not just the next one the list row carries.
 * Each show's day is its day AT THE VENUE. The full scheduling workspace stays one link away.
 */
export function EventCalendarView({
  organizationId,
  keep,
}: {
  organizationId: string;
  /** Event ids the list's other filters let through; null for all. */
  keep: Set<string> | null;
}) {
  const todayKey = useMemo(() => {
    const now = new Date();
    return `${monthKeyOf(now)}-${String(now.getDate()).padStart(2, '0')}`;
  }, []);
  const [month, setMonth] = useState(() => todayKey.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const range = monthRange(month);
  const q = useQuery({
    queryKey: ['events-month', organizationId, month],
    queryFn: () => api.events.calendar(organizationId, range.from, range.to),
    staleTime: 60_000,
  });

  const cells = useMemo(() => monthCells(month), [month]);
  const byDay = useMemo(
    () => sessionsByDay(q.data?.sessions ?? [], keep),
    [q.data?.sessions, keep],
  );
  const inMonth = cells.filter((c) => c.inMonth);
  const firstBusy = inMonth.find((c) => byDay.has(c.date))?.date;
  // The day shown: the one picked, else today in this month, else the first day with a show.
  const selected =
    picked && picked.startsWith(month)
      ? picked
      : todayKey.startsWith(month)
        ? todayKey
        : (firstBusy ?? `${month}-01`);
  const daySessions = byDay.get(selected) ?? [];
  const monthCount = inMonth.reduce((n, c) => n + (byDay.get(c.date)?.length ?? 0), 0);

  const go = (n: number) => {
    setMonth((m) => shiftMonth(m, n));
    setPicked(null);
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <section
        aria-labelledby="events-month-title"
        className="min-w-0 rounded-lg border border-border bg-background-surface p-4 shadow-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <h2
            id="events-month-title"
            aria-live="polite"
            className="font-display text-title font-semibold text-text-primary"
          >
            {monthTitle(month)}
          </h2>
          <div className="flex items-center gap-1">
            <IconButton
              icon={ChevronLeft}
              label="Previous month"
              variant="ghost"
              size="sm"
              onClick={() => go(-1)}
            />
            <IconButton
              icon={ChevronRight}
              label="Next month"
              variant="ghost"
              size="sm"
              onClick={() => go(1)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMonth(todayKey.slice(0, 7));
                setPicked(todayKey);
              }}
            >
              Today
            </Button>
          </div>
        </div>
        <p className="mt-0.5 text-caption text-text-muted">
          {q.isLoading
            ? 'Loading sessions'
            : `${monthCount} session${monthCount === 1 ? '' : 's'} this month`}
        </p>

        <div className="mt-3 grid grid-cols-7 text-center" aria-hidden>
          {WEEKDAYS.map((d) => (
            <span key={d} className="py-1 text-micro font-medium text-text-muted">
              {d}
            </span>
          ))}
        </div>
        {/*
          Buttons in a plain grid rather than an ARIA grid: each day is one control that shows
          its shows, named with the date and how many there are, so Tab and Enter are all a
          keyboard needs.
        */}
        <ul className="grid grid-cols-7 gap-y-1">
          {cells.map((c) => {
            const count = byDay.get(c.date)?.length ?? 0;
            const isToday = c.date === todayKey;
            const isPicked = c.date === selected;
            if (!c.inMonth)
              return (
                <li key={c.date} aria-hidden className="flex h-11 items-start justify-center pt-1">
                  <span className="text-caption text-text-muted">{c.day}</span>
                </li>
              );
            return (
              <li key={c.date} className="flex justify-center">
                <button
                  type="button"
                  aria-pressed={isPicked}
                  aria-label={`${dayTitle(c.date)}, ${count === 0 ? 'no sessions' : `${count} session${count === 1 ? '' : 's'}`}${isToday ? ', today' : ''}`}
                  onClick={() => setPicked(c.date)}
                  className={`flex h-11 w-full max-w-[2.5rem] flex-col items-center justify-start gap-1 rounded-md pt-1 text-caption tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background-surface ${
                    isPicked
                      ? 'bg-action-primary font-semibold text-action-primary-foreground'
                      : isToday
                        ? 'font-semibold text-action-primary ring-2 ring-inset ring-action-primary'
                        : 'text-text-primary hover:bg-background-subtle'
                  }`}
                >
                  {c.day}
                  <span aria-hidden className="flex h-1.5 items-center gap-0.5">
                    {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
                      <span
                        key={i}
                        className={`h-1.5 w-1.5 rounded-full ${isPicked ? 'bg-action-primary-foreground' : 'bg-action-primary'}`}
                      />
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {q.data?.truncated ? (
          <p className="mt-2 text-caption text-status-warning">
            This month has more sessions than one page shows. The calendar has all of them.
          </p>
        ) : null}
        <Link
          href="/organizer/calendar"
          className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CalendarDays className="h-4 w-4" aria-hidden />
          Open the full calendar
        </Link>
      </section>

      <section
        aria-labelledby="events-day-title"
        className="min-w-0 rounded-lg border border-border bg-background-surface p-4 shadow-xs"
      >
        <h2
          id="events-day-title"
          className="font-display text-title font-semibold text-text-primary"
        >
          {selected === todayKey ? 'Today - ' : ''}
          {dayTitle(selected)}
        </h2>
        {q.isError ? (
          <div className="mt-3">
            <ErrorState
              message="We couldn't load this month's sessions."
              onRetry={() => q.refetch()}
            />
          </div>
        ) : q.isLoading ? (
          <div className="mt-3 space-y-2" role="status" aria-label="Loading">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : daySessions.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              compact
              title="Nothing on this day"
              hint={
                monthCount > 0
                  ? 'Days with a dot have sessions.'
                  : 'No sessions this month for the events shown.'
              }
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border" aria-label="Sessions on this day">
            {daySessions.map((s) => (
              <li key={s.id} className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span
                  aria-hidden
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-action-primary"
                />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/organizer/events/${s.event.id}`}
                    className="line-clamp-2 break-words rounded-sm font-semibold text-text-primary [overflow-wrap:anywhere] hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {s.event.title}
                  </Link>
                  <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-text-secondary">
                    <span className="tabular-nums">{timeOf(s)}</span>
                    <span className="flex min-w-0 items-center gap-1">
                      <MapPin className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
                      <span className="truncate">
                        {s.venue.name}, {s.venue.city}
                      </span>
                    </span>
                    {s.capacity ? (
                      <span className="tabular-nums text-text-muted">
                        {s.sold ?? 0} / {s.capacity} sold
                      </span>
                    ) : null}
                  </p>
                </div>
                <span className="shrink-0">
                  <EventStateBadges event={{ status: s.event.status }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
