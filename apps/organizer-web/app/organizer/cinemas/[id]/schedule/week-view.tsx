'use client';

import { useQuery } from '@tanstack/react-query';
import {
  api,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  errorMessage,
  type ShowRow,
} from '@eticketsgo/web-kit';
import {
  effectiveShowBadge,
  formatDayHeading,
  formatLocalTime,
  localDateOf,
  weekDates,
} from './show-status';

/**
 * Seven days of a cinema, for planning.
 *
 * Answers one question — "how does this cinema look for the next seven days?" — and
 * deliberately does not try to be the day view. There are no pause/cancel/move controls
 * here: those live on the day view, which is where an operator has the context to use them.
 * Selecting a show jumps to its day rather than duplicating that machinery.
 *
 * One bounded request for the whole week, not seven. A week is a single question, and seven
 * round trips would render the view in seven jerks.
 *
 * Every date here is a LOCAL calendar date at the cinema. The same Hyderabad week must
 * appear identically to an operator in London, Boise or Sydney — bucketing on the browser's
 * zone is the defect already fixed twice on this page and it must not return through here.
 */
export function WeekView({
  cinemaId,
  anchorDate,
  timezone,
  screenFilter,
  onSelectDay,
}: {
  cinemaId: string;
  /** Any date within the week to show. */
  anchorDate: string;
  timezone: string;
  screenFilter: string;
  onSelectDay: (date: string) => void;
}) {
  const days = weekDates(anchorDate);
  const from = days[0];
  const to = days[days.length - 1];

  const weekQ = useQuery({
    queryKey: ['cinema', cinemaId, 'schedule-range', from, to, timezone],
    queryFn: () => api.shows.cinemaScheduleRange(cinemaId, from, to, timezone),
    enabled: Boolean(from && to),
  });

  if (weekQ.isPending) {
    return (
      <div
        className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
        aria-busy="true"
        aria-label="Loading week"
      >
        {days.map((d) => (
          <Skeleton key={d} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  if (weekQ.isError) {
    return <ErrorState message={errorMessage(weekQ.error)} onRetry={() => void weekQ.refetch()} />;
  }

  const rows = (weekQ.data ?? []).filter((r) => !screenFilter || r.screenId === screenFilter);
  const byDay = new Map<string, ShowRow[]>(days.map((d) => [d, []]));
  for (const row of rows) {
    const day = localDateOf(row.startsAt, timezone);
    byDay.get(day)?.push(row);
  }

  const total = rows.length;

  return (
    <div className="space-y-3">
      <p className="text-caption text-text-muted">
        Local dates and times at the cinema ({timezone}).
      </p>

      {total === 0 ? (
        <EmptyState
          title="Nothing scheduled this week"
          hint="Use Create shows to fill the week, or Copy schedule to repeat another day."
        />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {days.map((day) => {
          const shows = byDay.get(day) ?? [];
          return (
            /*
              The wrapper exists so each day column has one unambiguous boundary. Without it
              a "this show is NOT under Tuesday" assertion can only reach for some ancestor
              <div>, and the nearest one that matches is the whole grid — which contains every
              day, so the check silently passes on a broken bucket. Cheap element, real
              guarantee.
            */
            <div key={day} data-testid={`week-day-${day}`}>
              <Card>
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">{formatDayHeading(day)}</h3>
                  <button
                    type="button"
                    className="text-caption text-action-primary underline"
                    onClick={() => onSelectDay(day)}
                    aria-label={`Open ${formatDayHeading(day)} in the day view`}
                  >
                    Open day
                  </button>
                </div>

                {shows.length === 0 ? (
                  <p className="text-caption text-text-muted">No shows.</p>
                ) : (
                  <ul className="space-y-2">
                    {shows.map((show) => {
                      const described = effectiveShowBadge(show, new Date(), timezone);
                      return (
                        <li key={show.sessionId}>
                          <button
                            type="button"
                            onClick={() => onSelectDay(day)}
                            className="w-full rounded-md border border-border p-2 text-left hover:bg-background-subtle"
                            /*
                            One accessible name carrying everything a screen-reader user
                            needs, so the card is not read as four disconnected fragments —
                            and the state appears ONCE, not duplicated by a hidden span.
                          */
                            aria-label={`${formatLocalTime(show.startsAt, timezone)} ${
                              show.movieTitle ?? 'Untitled'
                            }, ${show.screenName ?? 'unassigned screen'}, ${described.label}. ${
                              described.hint
                            }`}
                          >
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="font-mono text-sm tabular-nums">
                                {formatLocalTime(show.startsAt, timezone)}
                              </span>
                              <Badge tone={described.tone}>{described.label}</Badge>
                            </span>
                            <span className="mt-0.5 block truncate text-sm font-medium">
                              {show.movieTitle ?? 'Untitled'}
                            </span>
                            <span className="block text-caption text-text-muted">
                              {show.screenName ?? '—'}
                              {show.seatsTotal > 0
                                ? ` · ${show.seatsSold}/${show.seatsTotal} sold`
                                : ''}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}
