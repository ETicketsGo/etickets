'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton, type ShowRow } from '@eticketsgo/web-kit';
import { isUpcoming, localDate } from './cinema-model';

const MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const DAY_NAME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "2026-10" -> the 42 local dates of its Monday-first month grid. */
function monthGrid(month: string): string[] {
  const first = new Date(`${month}-01T12:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - offset * 86_400_000);
  return Array.from({ length: 42 }, (_, i) =>
    new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10),
  );
}

function shiftMonth(month: string, by: number): string {
  const d = new Date(`${month}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

/**
 * The film's upcoming shows on a month calendar - the reference's calendar card, with real
 * data: a dot under each day the film plays (two for a busy day), today ringed in the accent.
 * A day with shows is a button that jumps the list below to that day.
 *
 * Every date is the CINEMA's: a show is placed on the day its own cinema calls it, so a late
 * show in one zone is not moved to tomorrow by the reader's clock. "Today" is the first
 * cinema's today, or the reader's while there is none.
 */
export function ShowCalendar({
  rows,
  now,
  zoneOf,
  onPickDay,
}: {
  rows: ShowRow[] | undefined;
  now: Date;
  zoneOf: (cinemaId: string | null | undefined) => string | undefined;
  onPickDay: (date: string) => void;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of rows ?? []) {
      if (!isUpcoming(s, now)) continue;
      const d = localDate(s.startsAt, zoneOf(s.cinemaId));
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  }, [rows, now, zoneOf]);
  const firstZone = zoneOf(rows?.find((s) => s.cinemaId)?.cinemaId);
  const today = localDate(now, firstZone);
  const firstShowDay = [...counts.keys()].sort()[0];
  const [month, setMonth] = useState<string | null>(null);
  const shown = month ?? (firstShowDay ?? today).slice(0, 7);
  const days = monthGrid(shown);
  const inMonth = [...counts.entries()].filter(([d]) => d.startsWith(shown));
  const showsInMonth = inMonth.reduce((n, [, c]) => n + c, 0);

  return (
    <section
      aria-labelledby="show-calendar"
      className="rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="show-calendar"
          className="font-display text-[1.0625rem] font-bold text-text-primary"
        >
          {MONTH.format(new Date(`${shown}-15T12:00:00Z`))}
        </h2>
        <div className="flex items-center gap-1">
          <IconButton
            icon={ChevronLeft}
            size="sm"
            label="Previous month"
            onClick={() => setMonth(shiftMonth(shown, -1))}
          />
          <IconButton
            icon={ChevronRight}
            size="sm"
            label="Next month"
            onClick={() => setMonth(shiftMonth(shown, 1))}
          />
        </div>
      </div>
      <p className="mt-0.5 text-caption text-text-muted" aria-live="polite">
        {showsInMonth === 0
          ? 'No upcoming shows this month'
          : `${showsInMonth} upcoming ${showsInMonth === 1 ? 'show' : 'shows'} on ${inMonth.length} ${
              inMonth.length === 1 ? 'day' : 'days'
            }`}
      </p>
      <table className="mt-3 w-full table-fixed border-separate border-spacing-y-0.5 text-center">
        <caption className="sr-only">Days with upcoming shows</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} scope="col" className="pb-1 text-micro font-medium text-text-muted">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, w) => (
            <tr key={w}>
              {days.slice(w * 7, w * 7 + 7).map((d) => {
                const n = counts.get(d) ?? 0;
                const outside = !d.startsWith(shown);
                const isToday = d === today;
                const label = `${DAY_NAME.format(new Date(`${d}T12:00:00Z`))}${
                  isToday ? ', today' : ''
                }${n ? `, ${n} ${n === 1 ? 'show' : 'shows'}` : ''}`;
                const face = (
                  <>
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-ui tabular-nums ${
                        isToday
                          ? 'font-bold text-action-primary ring-2 ring-action-primary'
                          : outside
                            ? 'text-text-muted'
                            : n
                              ? 'font-semibold text-text-primary'
                              : 'text-text-secondary'
                      }`}
                    >
                      {Number(d.slice(8))}
                    </span>
                    <span aria-hidden className="flex h-1.5 items-center gap-0.5">
                      {n > 0 ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-action-primary" />
                      ) : null}
                      {n > 1 ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-tile-amber-foreground" />
                      ) : null}
                    </span>
                  </>
                );
                return (
                  <td key={d} className="p-0">
                    {n > 0 && !outside ? (
                      <button
                        type="button"
                        aria-label={label}
                        onClick={() => onPickDay(d)}
                        className="mx-auto flex flex-col items-center gap-0.5 rounded-md px-0.5 py-0.5 transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {face}
                      </button>
                    ) : (
                      <span
                        className="mx-auto flex flex-col items-center gap-0.5 py-0.5"
                        aria-hidden={outside ? true : undefined}
                      >
                        {face}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
