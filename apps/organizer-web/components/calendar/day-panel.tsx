'use client';

import { StatusPill } from '@eticketsgo/web-kit';
import {
  displayStatus,
  formatClock,
  formatDayLong,
  statusTone,
  zoneAbbrev,
  type DayKey,
  type DaySegment,
} from '@/lib/calendar';
import { sessionLabel, type OpenSession } from './session-chip';
import { statusDot } from './status-style';

/** Sessions listed before "Open the day"; the day view lists every one. */
const PANEL_CAP = 8;

/** "19:00 - 22:00 IST", or the start alone for a session stored with no length. */
export function segmentTime(seg: DaySegment): string {
  const s = seg.session;
  const zone = zoneAbbrev(s.zone, s.startsAt);
  if (seg.continuesBefore) return `Until ${formatClock(s.endsAt, s.zone)} ${zone}`;
  if (seg.endMin <= seg.startMin && !seg.continuesAfter)
    return `${formatClock(s.startsAt, s.zone)} ${zone}`;
  return `${formatClock(s.startsAt, s.zone)} - ${formatClock(s.endsAt, s.zone)} ${zone}`;
}

/**
 * The chosen day beside the month: the reference's "Today" agenda card.
 *
 * The month grid answers "where is it busy"; this answers "what is on that day" without opening
 * anything - time, title, place and status in words. It follows the day the grid has focused, so
 * a click or an arrow key in the grid changes it, and on a phone (where a cell shows only dots)
 * it is how a day is read at all.
 */
export function DayPanel({
  day,
  segments,
  today,
  onOpen,
  onShowDay,
}: {
  day: DayKey;
  segments: DaySegment[];
  today: DayKey;
  onOpen: OpenSession;
  onShowDay: (day: DayKey) => void;
}) {
  const shown = segments.slice(0, PANEL_CAP);
  const hidden = segments.length - shown.length;
  return (
    <section
      aria-labelledby="calendar-day-panel"
      data-testid="calendar-day-panel"
      className="min-w-0 rounded-lg border border-border bg-background-surface shadow-xs xl:sticky xl:top-20"
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0">
          <h2
            id="calendar-day-panel"
            aria-live="polite"
            className="font-display text-[1.0625rem] font-bold text-text-primary"
          >
            {formatDayLong(day)}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-caption text-text-muted">
            {day === today && (
              <StatusPill tone="primary" size="sm">
                Today
              </StatusPill>
            )}
            {segments.length === 0
              ? 'Nothing scheduled'
              : `${segments.length} ${segments.length === 1 ? 'session' : 'sessions'}, at venue time`}
          </p>
        </div>
        {segments.length > 0 && (
          <button
            type="button"
            onClick={() => onShowDay(day)}
            className="shrink-0 rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open the day
          </button>
        )}
      </div>
      {segments.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-text-secondary">
          No sessions on this day. Pick another day in the month.
        </p>
      ) : (
        <ul className="px-2 pb-3 md:grid md:grid-cols-2 md:gap-x-2 xl:block">
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
                  className="flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md px-3 py-2.5 text-left transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusDot(status.status)}`}
                  />
                  <span className="min-w-0 flex-1 basis-40">
                    <span className="block truncate text-sm font-semibold text-text-primary">
                      {s.title}
                    </span>
                    <span className="block truncate text-caption tabular-nums text-text-secondary">
                      {segmentTime(seg)}
                    </span>
                    {s.venueName && (
                      <span className="block truncate text-caption text-text-muted">
                        {s.venueName}
                      </span>
                    )}
                  </span>
                  <StatusPill tone={statusTone(status.status)} size="sm" dot={false}>
                    {status.label}
                  </StatusPill>
                </button>
              </li>
            );
          })}
          {hidden > 0 && (
            <li className="px-3 pt-1 md:col-span-2">
              <button
                type="button"
                onClick={() => onShowDay(day)}
                className="rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {hidden} more on this day
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
