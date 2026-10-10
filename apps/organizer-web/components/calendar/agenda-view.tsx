'use client';

import { useEffect, useState } from 'react';
import { StatusPill } from '@eticketsgo/web-kit';
import {
  capItems,
  displayStatus,
  formatDayLong,
  statusTone,
  type DayKey,
  type DaySegment,
} from '@/lib/calendar';
import { segmentTime } from './day-panel';
import { sessionLabel, type OpenSession } from './session-chip';
import { statusDot } from './status-style';

/** Sessions listed per day before "Show N more"; the rest render only when asked for. */
export const AGENDA_DAY_CAP = 8;

/**
 * The calendar as a list, one card per day that has something on it. The default on a phone,
 * where a seven-column grid cannot show a title.
 *
 * A row is the same as a row of the day panel beside the month - dot, title, time and venue,
 * status in words - so the two views read as one calendar, not two designs.
 */
export function AgendaView({
  days,
  byDay,
  today,
  focusDay,
  onOpen,
}: {
  days: DayKey[];
  byDay: Map<DayKey, DaySegment[]>;
  today: DayKey;
  /** A day to scroll to and open in full - set when "+N more" sent the organizer here. */
  focusDay: DayKey | null;
  onOpen: OpenSession;
}) {
  const [expanded, setExpanded] = useState<Set<DayKey>>(() => new Set(focusDay ? [focusDay] : []));

  useEffect(() => {
    if (!focusDay) return;
    setExpanded((prev) => new Set(prev).add(focusDay));
    const el = document.getElementById(`agenda-${focusDay}`);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [focusDay]);

  const withSessions = days.filter((d) => (byDay.get(d)?.length ?? 0) > 0);
  if (withSessions.length === 0) return null;

  return (
    <div className="space-y-4">
      {withSessions.map((day) => {
        const all = byDay.get(day) ?? [];
        const open = expanded.has(day);
        const { shown, hidden } = open ? { shown: all, hidden: 0 } : capItems(all, AGENDA_DAY_CAP);
        return (
          <section
            key={day}
            aria-labelledby={`agenda-${day}`}
            data-testid={`agenda-day-${day}`}
            className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs"
          >
            <h3
              id={`agenda-${day}`}
              tabIndex={-1}
              className="flex scroll-mt-20 flex-wrap items-center gap-2 border-b border-border px-4 py-3 font-display text-ui font-bold text-text-primary focus:outline-none"
            >
              {formatDayLong(day)}
              {day === today && (
                <StatusPill tone="primary" size="sm">
                  Today
                </StatusPill>
              )}
              <span className="ml-auto text-caption font-medium text-text-muted">
                {all.length} {all.length === 1 ? 'session' : 'sessions'}
              </span>
            </h3>
            <ul className="divide-y divide-border">
              {shown.map((seg) => {
                const s = seg.session;
                const status = displayStatus(s);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-session-id={s.id}
                      aria-label={sessionLabel(s)}
                      onClick={(e) => onOpen(s, e.currentTarget)}
                      className="flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3 text-left transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusDot(status.status)}`}
                      />
                      <span className="min-w-0 flex-1 basis-40">
                        <span className="block truncate text-sm font-semibold text-text-primary">
                          {s.title}
                        </span>
                        <span className="block text-caption tabular-nums text-text-secondary">
                          {segmentTime(seg)}
                        </span>
                        <span className="block truncate text-caption text-text-muted">
                          {[s.venueName, s.city].filter(Boolean).join(', ')}
                        </span>
                      </span>
                      <StatusPill tone={statusTone(status.status)} size="sm" dot={false}>
                        {status.label}
                      </StatusPill>
                    </button>
                  </li>
                );
              })}
            </ul>
            {hidden > 0 && (
              <div className="border-t border-border px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => new Set(prev).add(day))}
                  className="rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Show {hidden} more on {formatDayLong(day)}
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
