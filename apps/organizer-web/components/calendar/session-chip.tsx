'use client';

import type { CSSProperties } from 'react';
import {
  displayStatus,
  formatClock,
  zoneAbbrev,
  type CalendarSession,
  type DaySegment,
} from '@/lib/calendar';
import { statusDot, statusRule } from './status-style';

export type OpenSession = (session: CalendarSession, trigger: HTMLElement) => void;

/**
 * Everything a screen-reader user needs about a session, in one accessible name - time WITH
 * its zone, title, place and status - so a chip is not read as scattered fragments.
 */
export function sessionLabel(s: CalendarSession): string {
  const time = `${formatClock(s.startsAt, s.zone)} ${zoneAbbrev(s.zone, s.startsAt)}`;
  const place = [s.venueName, s.city].filter(Boolean).join(', ');
  return `${time}, ${s.title}${place ? `, ${place}` : ''}. ${displayStatus(s).label}`;
}

/**
 * A compact session for a month cell: status dot and time, the title under them.
 *
 * Quiet by design. A busy month is a wall of these, and thirty tinted boxes read as noise;
 * a dot and a line of text scan like the reference's calendar card. The words of the status
 * are in the accessible name and in the day panel beside the grid.
 */
export function SessionChip({
  segment,
  onOpen,
  tabbable,
}: {
  segment: DaySegment;
  onOpen: OpenSession;
  tabbable: boolean;
}) {
  const s = segment.session;
  const shown = displayStatus(s);
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      data-session-id={s.id}
      aria-label={sessionLabel(s)}
      title={sessionLabel(s)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(s, e.currentTarget);
      }}
      className="block w-full min-w-0 rounded-md px-1.5 py-0.5 text-left text-micro leading-[1.125rem] text-text-primary transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${statusDot(shown.status)}`} />
        <span className="font-semibold tabular-nums">
          {segment.continuesBefore ? 'cont.' : formatClock(s.startsAt, s.zone)}
        </span>
      </span>
      {/* The title on its own line: beside the time, a month cell leaves it a few letters. */}
      <span
        className={`block truncate pl-3.5 text-text-secondary ${shown.status === 'CANCELLED' ? 'line-through' : ''}`}
      >
        {s.title}
      </span>
    </button>
  );
}

/** A session in the week/day time grid, positioned by the caller. */
export function SessionBlock({
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
      onClick={(e) => onOpen(s, e.currentTarget)}
      style={style}
      className={`absolute flex flex-col justify-start overflow-hidden rounded-md border border-l-[3px] border-border bg-background-surface px-2 py-1 text-left text-micro leading-tight text-text-primary shadow-xs transition-shadow duration-150 hover:z-10 hover:shadow-md focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${statusRule(shown.status)}`}
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
