'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  Meter,
  SegmentedControl,
  Select,
  Skeleton,
  dateTime,
  type ShowRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { sessionSaleStates } from '@/lib/sale-state';
import {
  dateLabel,
  dayHeading,
  formatClock,
  groupByDay,
  isUpcoming,
  localDate,
  showSaleVerdict,
  zoneShort,
  type SaleVerdict,
} from './cinema-model';
import { SaleChip } from './sale-chip';

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
}: {
  rows: ShowRow[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  zoneOf: (cinemaId: string | null | undefined) => string | undefined;
  onOpen: (show: ShowRow, verdict: SaleVerdict) => void;
  onEdit: (show: ShowRow) => void;
  onSchedule: () => void;
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
  const askedIds = useMemo(() => shown.map((s) => s.sessionId).sort(), [shown]);
  const statesQ = useQuery({
    queryKey: ['organizer-sale-eligibility', activeOrg.id, askedIds.join(',')],
    queryFn: () => sessionSaleStates(activeOrg.id, askedIds),
    enabled: askedIds.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const stateBySession = useMemo(
    () => new Map((statesQ.data ?? []).map((a) => [a.sessionId, a])),
    [statesQ.data],
  );

  const verdictOf = (s: ShowRow): SaleVerdict =>
    showSaleVerdict({
      show: s,
      timeZone: zoneOf(s.cinemaId),
      sale: statesQ.isError
        ? null
        : statesQ.data
          ? (stateBySession.get(s.sessionId) ?? null)
          : undefined,
    });

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
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
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
        <div className="space-y-5">
          {days.map((day) => {
            const today = localDate(now, zoneOf(day.shows[0]!.cinemaId));
            const heading = dayHeading(day.date, today);
            const isToday = day.date === today;
            return (
              <section key={day.date} aria-label={heading} className="space-y-2">
                <h3 className="flex items-center gap-2 text-[0.9375rem] font-semibold text-text-primary">
                  {isToday ? (
                    <>
                      {/*
                        The one warm "marquee" moment on the page: today. Amber from the
                        default palette, paired with the word, and never used for a warning.
                      */}
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-caption font-semibold text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">
                        Today
                      </span>
                      <span>{dateLabel(day.date, today)}</span>
                    </>
                  ) : (
                    heading
                  )}
                  <span className="text-caption font-normal text-text-muted">
                    {day.shows.length} {day.shows.length === 1 ? 'show' : 'shows'}
                  </span>
                </h3>
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background-surface">
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
                        className="grid grid-cols-[4.5rem_1fr] items-start gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-background-subtle/60 md:grid-cols-[4.5rem_minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] md:items-center"
                      >
                        <p className="leading-tight">
                          <span className="block text-[1.0625rem] font-semibold tabular-nums text-text-primary">
                            {formatClock(s.startsAt, zone)}
                          </span>
                          <span className="text-caption text-text-muted">
                            {zoneShort(s.startsAt, zone)}
                          </span>
                        </p>
                        <div className="min-w-0">
                          <p className="break-words font-medium text-text-primary">
                            {s.cinemaName ?? 'Unknown cinema'}
                          </p>
                          <p className="text-caption text-text-muted">
                            {s.screenName ?? 'No screen'} - ends {formatClock(s.endsAt, zone)}
                          </p>
                        </div>
                        <div className="col-start-2 min-w-0 md:col-start-auto">
                          <p className="text-caption tabular-nums text-text-secondary">
                            {s.seatsSold} / {s.seatsTotal} sold
                          </p>
                          {s.seatsTotal > 0 ? (
                            <div className="mt-1 max-w-[9rem]">
                              <Meter
                                value={s.seatsSold}
                                max={s.seatsTotal}
                                label={`Seats sold, ${when} show`}
                              />
                            </div>
                          ) : null}
                        </div>
                        <div className="col-start-2 min-w-0 md:col-start-auto">
                          <SaleChip verdict={verdict} />
                        </div>
                        <div className="col-start-2 flex flex-wrap gap-2 md:col-start-auto md:justify-end">
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
