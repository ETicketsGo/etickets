'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import {
  CALENDAR_RULE,
  CalendarChip,
  CalendarTodayBadge,
  type OpenCalendarEntry,
} from '@eticketsgo/web-kit';
import {
  capItems,
  displayStatus,
  entryFor,
  formatClock,
  formatDayLong,
  formatDayShort,
  layoutDay,
  sessionLabel,
  splitSpanning,
  statusTone,
  zoneAbbrev,
  type CalendarSession,
  type DayKey,
  type DaySegment,
} from '@/lib/calendar';

type OpenSession = OpenCalendarEntry<CalendarSession>;

/**
 * A session in the week/day time grid, positioned by the caller. Only the organizer calendar
 * draws an hour grid, so this block lives here; its dot colours and words are the shared ones.
 */
function SessionBlock({
  segment,
  onOpen,
  style,
  narrow,
}: {
  segment: DaySegment;
  onOpen: OpenSession;
  style: CSSProperties;
  /** Shares its column with others: show less so the time and title still fit. */
  narrow: boolean;
}) {
  const s = segment.session;
  const shown = displayStatus(s);
  const start = segment.continuesBefore ? 'cont.' : formatClock(s.startsAt, s.zone);
  return (
    <button
      type="button"
      data-session-id={s.id}
      aria-label={sessionLabel(s)}
      title={sessionLabel(s)}
      onClick={(e) => onOpen(entryFor(segment), e.currentTarget)}
      style={style}
      className={`absolute flex flex-col justify-start overflow-hidden rounded-md border border-l-[3px] border-border bg-background-surface px-2 py-1 text-left text-micro leading-tight text-text-primary shadow-xs transition-shadow duration-150 hover:z-10 hover:shadow-md focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${CALENDAR_RULE[statusTone(shown.status)]}`}
    >
      <span className="flex items-center gap-1">
        <span className="font-semibold tabular-nums">{start}</span>
        {!narrow && (
          <span className="truncate text-text-muted">{zoneAbbrev(s.zone, s.startsAt)}</span>
        )}
      </span>
      <span className="block truncate font-semibold">{s.title}</span>
      {!narrow && (
        <>
          <span className="block truncate text-text-secondary">
            {[s.venueName, s.city].filter(Boolean).join(', ')}
          </span>
          <span className="block truncate text-text-secondary">{shown.label}</span>
        </>
      )}
    </button>
  );
}

const HOUR_PX = 48;
/** Sessions crossing midnight, listed per day in the strip above the hours. */
const SPANNING_CAP = 3;
const MIN_BLOCK_MINUTES = 30;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Week and day views: one column per day, a row per hour, sessions placed by VENUE-LOCAL
 * minute. Overlapping sessions share their column side by side (`layoutDay`), none on top of
 * another. A day column holds at most `cap` sessions; past that, "+N more" opens the agenda
 * for that day, where every session is listed - a column of forty slivers hides them as surely
 * as not drawing them would.
 */
export function TimeGrid({
  days,
  byDay,
  today,
  cap,
  onOpen,
  onShowMore,
}: {
  days: DayKey[];
  byDay: Map<DayKey, DaySegment[]>;
  today: DayKey;
  cap: number;
  onOpen: OpenSession;
  onShowMore: (day: DayKey) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const daysKey = days.join(',');

  // Open at the first session of the range (or 08:00), not at midnight with nothing in view.
  useEffect(() => {
    let first = 8 * 60;
    for (const d of days) {
      const seg = byDay.get(d)?.[0];
      if (seg && seg.startMin < first) first = seg.startMin;
    }
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (first / 60 - 0.5) * HOUR_PX);
    // Re-run when the range changes, not on every data refresh: a refetch must not yank the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daysKey]);

  const single = days.length === 1;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background-surface shadow-xs">
      <div className={single ? '' : 'min-w-[44rem]'}>
        <div
          className="grid border-b border-border"
          style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}
        >
          <div />
          {days.map((d) => {
            const total = byDay.get(d)?.length ?? 0;
            return (
              <div
                key={d}
                className="border-l border-border px-2 py-2.5 text-caption"
                data-testid={`grid-day-${d}`}
              >
                <span
                  className={`inline-flex items-center gap-1.5 font-semibold ${d === today ? 'text-action-primary' : 'text-text-primary'}`}
                >
                  {single ? formatDayLong(d) : formatDayShort(d)}
                  {d === today && <CalendarTodayBadge />}
                </span>
                <span className="block text-text-muted">
                  {total === 0 ? 'No sessions' : total === 1 ? '1 session' : `${total} sessions`}
                </span>
              </div>
            );
          })}
        </div>
        {days.some((d) => splitSpanning(byDay.get(d) ?? []).spanning.length > 0) && (
          <div
            className="grid border-b border-border"
            style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}
            data-testid="spanning-strip"
          >
            <div className="px-1 py-1.5 text-right text-caption text-text-muted">Multi-day</div>
            {days.map((d) => {
              const { spanning } = splitSpanning(byDay.get(d) ?? []);
              const { shown, hidden } = capItems(spanning, SPANNING_CAP);
              return (
                <div key={d} className="min-w-0 space-y-0.5 border-l border-border p-1">
                  {shown.map((seg) => (
                    <CalendarChip key={seg.session.id} entry={entryFor(seg)} onOpen={onOpen} />
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => onShowMore(d)}
                      className="rounded px-1 text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      +{hidden} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div
          ref={scrollRef}
          className="max-h-[70vh] overflow-y-auto"
          data-testid="time-grid-scroll"
        >
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))`,
              height: 24 * HOUR_PX,
            }}
          >
            <div className="relative" aria-hidden>
              {HOURS.map((h) => (
                <div
                  key={h}
                  className="absolute right-1 -translate-y-1/2 font-mono text-caption tabular-nums text-text-muted"
                  style={{ top: h * HOUR_PX }}
                >
                  {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
                </div>
              ))}
            </div>
            {days.map((d) => {
              const { timed } = splitSpanning(byDay.get(d) ?? []);
              const { shown, hidden } = capItems(timed, cap);
              const placed = layoutDay(shown, MIN_BLOCK_MINUTES);
              return (
                <div
                  key={d}
                  className="relative border-l border-border"
                  role="group"
                  aria-label={formatDayLong(d)}
                >
                  {HOURS.map((h) => (
                    <div
                      key={h}
                      aria-hidden
                      className="absolute inset-x-0 border-t border-border"
                      style={{ top: h * HOUR_PX }}
                    />
                  ))}
                  {placed.map(({ segment, column, columns }) => {
                    const minutes = Math.max(segment.endMin - segment.startMin, MIN_BLOCK_MINUTES);
                    return (
                      <SessionBlock
                        key={segment.session.id}
                        segment={segment}
                        onOpen={onOpen}
                        narrow={columns > 1 || !single}
                        style={{
                          top: (segment.startMin / 60) * HOUR_PX,
                          height: Math.max((minutes / 60) * HOUR_PX - 2, 20),
                          left: `calc(${(column / columns) * 100}% + 2px)`,
                          width: `calc(${100 / columns}% - 4px)`,
                        }}
                      />
                    );
                  })}
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => onShowMore(d)}
                      className="sticky top-1 z-20 m-1 rounded bg-background-elevated px-2 py-0.5 text-caption font-medium text-action-primary shadow-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`${hidden} more on ${formatDayLong(d)}. Show the list`}
                    >
                      +{hidden} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
