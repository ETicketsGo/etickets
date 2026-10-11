'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  CalendarRow,
  ErrorState,
  SectionCard,
  SectionLink,
  Skeleton,
  type AdminCalendarSession,
  type OpenCalendarEntry,
} from '@eticketsgo/web-kit';
import { viewerToday } from '@eticketsgo/shared-types';
import { addDays, entryFor, placeSessions } from '@/lib/calendar';

/** Rows shown before "See all"; the calendar lists every one. Even, so a tablet's two columns end level. */
const LIMIT = 6;

/**
 * What is on today across the platform: the reference's "Today" agenda, for an operator.
 *
 * Read from the calendar's own endpoint and placed by the calendar's own rules - today is the
 * reader's date (`viewer-today.ts`), and a show belongs to the day on its VENUE's clock - so
 * this card and the calendar it links to always list the same shows. EVENT_REVIEW, as the
 * calendar; the parent decides.
 */
export function TodayShows() {
  const router = useRouter();
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
    () => (placeSessions(shows.data?.data ?? [], [today]).byDay[today] ?? []).map(entryFor),
    [shows.data, today],
  );
  /*
    A row is the calendar's own (web-kit's CalendarRow: status dot, title, venue time, place and
    the status in words), so this card and the calendar cannot drift apart. Here it opens the
    event, as the old link did; the calendar's quick look belongs to the calendar.
  */
  const open: OpenCalendarEntry<AdminCalendarSession> = (entry) =>
    router.push(`/admin/events/${entry.source.event.id}`);

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
        <div className="px-5 pb-4">
          <Skeleton className="h-56 w-full md:h-40" />
        </div>
      ) : shows.isError ? (
        <div className="px-5 pb-3">
          <ErrorState message="We could not load today's shows." onRetry={() => shows.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-text-secondary">No shows on the platform today.</p>
      ) : (
        <>
          {/*
            One column of rows on a phone and a wide screen's main column; two on a tablet, where
            a single column of six rows was a third of the screen for one card.
          */}
          <ul className="divide-y divide-border border-t border-border md:grid md:grid-cols-2 md:divide-y-0 md:px-2 md:py-1 xl:block xl:divide-y xl:px-0 xl:py-0">
            {list.slice(0, LIMIT).map((entry) => (
              <li key={entry.id} className="min-w-0">
                <CalendarRow entry={entry} onOpen={open} />
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
