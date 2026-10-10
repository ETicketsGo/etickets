'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  ErrorState,
  SectionCard,
  SectionLink,
  Skeleton,
  StatusPill,
  type AdminCalendarSession,
} from '@eticketsgo/web-kit';
import { viewerToday } from '@eticketsgo/shared-types';
import {
  addDays,
  localTime,
  placeSessions,
  showStatus,
  statusTone,
  zoneNote,
  type StatusTone,
} from '@/lib/calendar';

/** Rows shown before "View the day"; the calendar lists every one. */
const LIMIT = 6;

const DOT: Record<StatusTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

/**
 * What is on today across the platform: the reference's "Today" agenda, for an operator.
 *
 * Read from the calendar's own endpoint and placed by the calendar's own rules - today is the
 * reader's date (`viewer-today.ts`), and a show belongs to the day on its VENUE's clock - so
 * this card and the calendar it links to always list the same shows. EVENT_REVIEW, as the
 * calendar; the parent decides.
 */
export function TodayShows() {
  // The reader's today, taken again once mounted: the server renders in UTC.
  const [viewer, setViewer] = useState(() => viewerToday(new Date()));
  useEffect(() => setViewer(viewerToday(new Date())), []);
  const today = viewer.day;

  const shows = useQuery({
    queryKey: ['admin', 'calendar', 'today', today],
    // One day of padding each side, as the calendar's `fetchWindow` does for every zone.
    queryFn: () => api.admin.eventCalendar({ from: addDays(today, -1), to: addDays(today, 1) }),
  });

  const list = useMemo(
    () => placeSessions(shows.data?.data ?? [], [today]).byDay[today] ?? [],
    [shows.data, today],
  );

  return (
    <SectionCard
      title="Today on the platform"
      description="Every show on today's date at its own venue, at venue time."
      action={
        <SectionLink href="/admin/calendar" srLabel="calendar">
          Open calendar
        </SectionLink>
      }
      flush
    >
      {shows.isLoading ? (
        <div className="px-5 pb-3">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : shows.isError ? (
        <div className="px-5 pb-3">
          <ErrorState message="We could not load today's shows." onRetry={() => shows.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-text-secondary">No shows on the platform today.</p>
      ) : (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {list.slice(0, LIMIT).map((s) => (
              <li key={s.id}>
                <Row s={s} />
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-5 pt-3 text-caption text-text-muted">
            {list.length} {list.length === 1 ? 'show' : 'shows'} today
            {shows.data?.meta.truncated ? ' (more than the calendar lists at once)' : ''}.{' '}
            {list.length > LIMIT && (
              <Link
                href="/admin/calendar?view=agenda"
                className="rounded-sm font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                See all {list.length}
              </Link>
            )}
          </p>
        </>
      )}
    </SectionCard>
  );
}

function Row({ s }: { s: AdminCalendarSession }) {
  const shown = showStatus(s);
  return (
    <Link
      href={`/admin/events/${s.event.id}`}
      className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-5 py-3 transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[statusTone(shown.status)]}`}
      />
      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate text-ui font-semibold text-text-primary">
          {s.event.title}
        </span>
        <span className="block truncate text-caption tabular-nums text-text-secondary">
          {localTime(s.startsAt, s.timezone)} {zoneNote(s.startsAt, s.timezone)} -{' '}
          {s.organization.name}, {s.venue.city}
        </span>
      </span>
      <StatusPill tone={statusTone(shown.status)} size="sm" dot={false}>
        {shown.label}
      </StatusPill>
    </Link>
  );
}
