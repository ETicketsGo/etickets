'use client';

import type { CSSProperties } from 'react';
import {
  displayStatus,
  formatClock,
  zoneAbbrev,
  type CalendarSession,
  type DaySegment,
} from '@/lib/calendar';
import { statusLook } from './status-style';

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

/** A compact session for a month cell: icon, time, title. */
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
  const look = statusLook(displayStatus(s).status);
  const Icon = look.icon;
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
      className={`flex w-full min-w-0 items-center gap-1 rounded border-l-2 px-1 py-0.5 text-left text-caption text-text-primary hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${look.chip}`}
    >
      <Icon className={`h-3 w-3 shrink-0 ${look.accent}`} aria-hidden />
      <span className="shrink-0 font-mono tabular-nums">
        {segment.continuesBefore ? 'cont.' : formatClock(s.startsAt, s.zone)}
      </span>
      <span className="hidden min-w-0 truncate sm:inline">{s.title}</span>
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
  const look = statusLook(shown.status);
  const Icon = look.icon;
  const start = segment.continuesBefore ? 'cont.' : formatClock(s.startsAt, s.zone);
  return (
    <button
      type="button"
      data-session-id={s.id}
      aria-label={sessionLabel(s)}
      title={sessionLabel(s)}
      onClick={(e) => onOpen(s, e.currentTarget)}
      style={style}
      className={`absolute flex flex-col justify-start overflow-hidden rounded border-l-4 px-1.5 py-1 text-left text-caption leading-tight text-text-primary shadow-xs hover:z-10 hover:brightness-95 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${look.chip}`}
    >
      <span className="flex items-center gap-1">
        <Icon className={`h-3 w-3 shrink-0 ${look.accent}`} aria-hidden />
        <span className="font-mono tabular-nums">{start}</span>
        {!narrow && (
          <span className="truncate text-text-secondary">{zoneAbbrev(s.zone, s.startsAt)}</span>
        )}
      </span>
      <span className="block truncate font-medium">{s.title}</span>
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
