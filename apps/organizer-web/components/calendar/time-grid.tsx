'use client';

import { useEffect, useRef } from 'react';
import {
  capItems,
  formatDayLong,
  formatDayShort,
  layoutDay,
  splitSpanning,
  type DayKey,
  type DaySegment,
} from '@/lib/calendar';
import { SessionBlock, SessionChip, type OpenSession } from './session-chip';

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
    <div className="overflow-x-auto rounded-lg border border-border bg-background-surface">
      <div className={single ? '' : 'min-w-[44rem]'}>
        <div
          className="grid border-b border-border bg-background-subtle"
          style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}
        >
          <div />
          {days.map((d) => {
            const total = byDay.get(d)?.length ?? 0;
            return (
              <div
                key={d}
                className="border-l border-border px-2 py-2 text-caption"
                data-testid={`grid-day-${d}`}
              >
                <span
                  className={`font-semibold ${d === today ? 'text-action-primary' : 'text-text-primary'}`}
                >
                  {single ? formatDayLong(d) : formatDayShort(d)}
                </span>
                {d === today && <span className="ml-1 text-text-secondary">(today)</span>}
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
                    <SessionChip key={seg.session.id} segment={seg} onOpen={onOpen} tabbable />
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
