'use client';

import { useEffect, useState } from 'react';
import {
  capItems,
  displayStatus,
  formatClock,
  formatDayLong,
  zoneAbbrev,
  type DayKey,
  type DaySegment,
} from '@/lib/calendar';
import { sessionLabel, type OpenSession } from './session-chip';
import { statusLook } from './status-style';

/** Sessions listed per day before "Show N more"; the rest render only when asked for. */
export const AGENDA_DAY_CAP = 8;

/**
 * The calendar as a list, one heading per day that has something on it. The default on a
 * phone, where a seven-column grid cannot show a title.
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
          <section key={day} aria-labelledby={`agenda-${day}`} data-testid={`agenda-day-${day}`}>
            <h3
              id={`agenda-${day}`}
              tabIndex={-1}
              className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-text-primary focus:outline-none"
            >
              {formatDayLong(day)}
              {day === today && (
                <span className="text-caption font-medium text-action-primary">Today</span>
              )}
            </h3>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background-surface">
              {shown.map((seg) => {
                const s = seg.session;
                const shownStatus = displayStatus(s);
                const look = statusLook(shownStatus.status);
                const Icon = look.icon;
                // A session stored with no length has a start and nothing more to say.
                const time = seg.continuesBefore
                  ? `Continues until ${formatClock(s.endsAt, s.zone)}`
                  : seg.endMin <= seg.startMin && !seg.continuesAfter
                    ? formatClock(s.startsAt, s.zone)
                    : `${formatClock(s.startsAt, s.zone)} - ${formatClock(s.endsAt, s.zone)}`;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-session-id={s.id}
                      aria-label={sessionLabel(s)}
                      onClick={(e) => onOpen(s, e.currentTarget)}
                      className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden
                        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${look.chip}`}
                      >
                        <Icon className={`h-4 w-4 ${look.accent}`} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-caption tabular-nums text-text-secondary">
                          {time} {zoneAbbrev(s.zone, s.startsAt)}
                        </span>
                        <span className="block truncate font-medium text-text-primary">
                          {s.title}
                        </span>
                        <span className="block truncate text-caption text-text-muted">
                          {[s.venueName, s.city].filter(Boolean).join(', ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-caption font-medium text-text-secondary">
                        {shownStatus.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => new Set(prev).add(day))}
                className="mt-1 rounded px-1 text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show {hidden} more on {formatDayLong(day)}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
