'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Pencil } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  ProgressMeter,
  SegmentedControl,
  Select,
  Skeleton,
  StatusPill,
  dateTime,
  type ShowRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { useShowVerdicts } from './use-cinema-data';
import {
  dateLabel,
  dayHeading,
  formatClock,
  groupByDay,
  isUpcoming,
  localDate,
  zoneShort,
  type SaleVerdict,
} from './cinema-model';
import { SalePill } from './sale-pill';

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });

type Range = 'upcoming' | 'past' | 'all';

const PAGE = 30;

/**
 * Every showtime of one film, by day, across all its cinemas and screens.
 *
 * Each show is read on its cinema's clock and carries the server's answer to "can somebody
 * buy this": its unified sale state, built from what checkout reads (status, film, booking
 * window, places, and the sale-eligibility rule checkout refuses with).
 */
export function Showtimes({
  rows,
  loading,
  error,
  onRetry,
  zoneOf,
  onOpen,
  onEdit,
  onSchedule,
  focus,
}: {
  rows: ShowRow[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  zoneOf: (cinemaId: string | null | undefined) => string | undefined;
  onOpen: (show: ShowRow, verdict: SaleVerdict) => void;
  onEdit: (show: ShowRow) => void;
  onSchedule: () => void;
  /** A day picked on the calendar: the list shows it and scrolls to it. `at` re-triggers. */
  focus?: { date: string; at: number } | null;
}) {
  const [range, setRange] = useState<Range>('upcoming');
  const [cinemaId, setCinemaId] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [now] = useState(() => new Date());

  const cinemas = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) if (r.cinemaId) m.set(r.cinemaId, r.cinemaName ?? 'Unknown cinema');
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows ?? [];
    if (cinemaId) list = list.filter((s) => s.cinemaId === cinemaId);
    if (range === 'upcoming') list = list.filter((s) => isUpcoming(s, now));
    if (range === 'past') list = list.filter((s) => !isUpcoming(s, now)).reverse();
    return list;
  }, [rows, cinemaId, range, now]);
  const shown = filtered.slice(0, limit);

  /*
    The server's unified answer for every show on screen - the same one the Overview and the
    event pages read, so a show cannot be "Selling" here and "Not selling" there. One request
    per 50 shows (a page is 30). Owners and managers only; anybody else sees "Sale status
    unavailable", never a guess.
  */
  const { activeOrg } = useOrg();
  const verdictOf = useShowVerdicts(activeOrg.id, shown, zoneOf);

  /*
    Jump to a day picked on the calendar. The calendar offers only upcoming days, so the list
    goes back to "Upcoming" for all cinemas, and the page grows until that day is on it.
  */
  useEffect(() => {
    if (!focus) return;
    setRange('upcoming');
    setCinemaId('');
    const upcoming = (rows ?? []).filter((s) => isUpcoming(s, now));
    const at = upcoming.findIndex((s) => localDate(s.startsAt, zoneOf(s.cinemaId)) === focus.date);
    if (at >= 0) setLimit((l) => Math.max(l, (Math.floor(at / PAGE) + 1) * PAGE));
    const t = window.setTimeout(() => {
      const el = document.getElementById(`showday-${focus.date}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const days = groupByDay(shown, zoneOf);
  if (range === 'past') days.reverse();

  const upcomingCount = (rows ?? []).filter((s) => isUpcoming(s, now)).length;
  const pastCount = (rows ?? []).length - upcomingCount;

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Filter showtimes" className="flex flex-wrap items-center gap-2">
        <SegmentedControl<Range>
          label="Which showtimes"
          value={range}
          onChange={(r) => {
            setRange(r);
            setLimit(PAGE);
          }}
          options={[
            { value: 'upcoming', label: `Upcoming (${upcomingCount})` },
            { value: 'past', label: `Past (${pastCount})` },
            { value: 'all', label: 'All' },
          ]}
        />
        {cinemas.length > 1 ? (
          <div className="w-full sm:w-64">
            <Select
              aria-label="Filter by cinema"
              value={cinemaId}
              onChange={(e) => {
                setCinemaId(e.target.value);
                setLimit(PAGE);
              }}
            >
              <option value="">All cinemas</option>
              {cinemas.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {error ? (
        <ErrorState message="We couldn't load shows. Please try again." onRetry={onRetry} />
      ) : loading ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={CalendarPlus}
          title={range === 'past' ? 'No past shows' : 'No shows scheduled yet'}
          hint={
            range === 'past'
              ? 'Shows appear here once they have played.'
              : 'Schedule a show to start selling seats.'
          }
          action={
            range === 'past' ? undefined : (
              /*
                Not "Schedule a run" again: that is the page's primary action, and two buttons
                with one name on one page are two things a screen reader cannot tell apart.
              */
              <Button variant="outline" onClick={onSchedule}>
                Plan the first showtimes
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-4">
          {days.map((day) => {
            const zone = zoneOf(day.shows[0]!.cinemaId);
            const today = localDate(now, zone);
            const heading = dayHeading(day.date, today);
            const isToday = day.date === today;
            const d = new Date(`${day.date}T12:00:00Z`);
            return (
              <section
                key={day.date}
                id={`showday-${day.date}`}
                tabIndex={-1}
                aria-label={heading}
                className="scroll-mt-20 overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <h3 className="flex items-center gap-3 border-b border-border px-4 py-3">
                  {/*
                    The day as a calendar leaf, the reference's calendar card in miniature.
                    Today is ringed in the accent and says "Today" in words as well.
                  */}
                  <span
                    aria-hidden
                    className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-md leading-none ${
                      isToday
                        ? 'bg-tint-primary text-action-primary ring-2 ring-action-primary/60'
                        : 'bg-background-subtle text-text-primary'
                    }`}
                  >
                    <span className="text-[0.625rem] font-semibold uppercase tracking-wide opacity-80">
                      {WEEKDAY.format(d)}
                    </span>
                    <span className="mt-0.5 font-display text-[1.0625rem] font-bold tabular-nums">
                      {d.getUTCDate()}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 font-display text-[0.9375rem] font-bold text-text-primary">
                      {isToday ? (
                        <>
                          <StatusPill tone="marquee" size="sm">
                            Today
                          </StatusPill>
                          {dateLabel(day.date, today)}
                        </>
                      ) : (
                        heading
                      )}
                    </span>
                    <span className="block text-caption font-normal text-text-muted">
                      {day.shows.length} {day.shows.length === 1 ? 'show' : 'shows'}
                    </span>
                  </span>
                </h3>
                <ul className="divide-y divide-border">
                  {day.shows.map((s) => {
                    const zone = zoneOf(s.cinemaId);
                    const verdict = verdictOf(s);
                    const editable =
                      (s.status === 'SCHEDULED' || s.status === 'PAUSED') &&
                      new Date(s.startsAt) > now;
                    const when = dateTime(s.startsAt, undefined, zone);
                    return (
                      <li
                        key={s.sessionId}
                        className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 px-4 py-3.5 transition-colors duration-150 hover:bg-background-subtle/60 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto] sm:gap-x-4"
                      >
                        <p className="leading-tight">
                          <span className="block font-display text-[1.125rem] font-bold tabular-nums text-text-primary">
                            {formatClock(s.startsAt, zone)}
                          </span>
                          <span className="text-micro text-text-muted">
                            {zoneShort(s.startsAt, zone)}
                          </span>
                        </p>
                        <div className="min-w-0 space-y-2">
                          <div className="min-w-0">
                            <p className="break-words text-ui font-semibold text-text-primary">
                              {s.cinemaName ?? 'Unknown cinema'}
                            </p>
                            <p className="text-caption text-text-muted">
                              {s.screenName ?? 'No screen'} - ends {formatClock(s.endsAt, zone)}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <div className="w-full max-w-[11rem]">
                              <ProgressMeter
                                value={s.seatsSold}
                                max={s.seatsTotal}
                                size="sm"
                                label={`Seats sold, ${when} show`}
                              />
                            </div>
                            <div className="min-w-0">
                              <SalePill verdict={verdict} size="sm" wrap />
                            </div>
                          </div>
                        </div>
                        <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-3 sm:self-center sm:justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Details for the ${when} show at ${s.cinemaName ?? 'the cinema'}`}
                            onClick={() => onOpen(s, verdict)}
                          >
                            Details
                          </Button>
                          {editable ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={Pencil}
                              aria-label={`Edit the ${when} show`}
                              onClick={() => onEdit(s)}
                            >
                              Edit
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {filtered.length > shown.length ? (
            <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown.length)} more
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
