'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  api,
  Button,
  EmptyState,
  ErrorState,
  SegmentedControl,
  Skeleton,
  type EventSession,
} from '@eticketsgo/web-kit';
import { timeAtVenue } from '@/components/events/event-list-model';
import { ChangeSeatingDialog } from '@/components/events/change-seating-dialog';
import { SeatMapPreviewDialog } from '@/components/events/seat-map-preview';
import { SessionSeatingCard } from '@/components/events/session-seating-card';
import {
  filterSessions,
  layoutLabel,
  resolveLayout,
  seatingMix,
  sessionSeating,
  spaceFor,
  type LayoutRow,
  type LayoutVersion,
  type SessionFilter,
} from '@/components/events/seating-model';

const PAGE = 20;

/**
 * Seating, for an event that already exists.
 *
 * ── WHY THIS PAGE ─────────────────────────────────────────────────────────────────
 * Every piece of seating already existed - spaces, layout versions, the per-show seat
 * inventory, the endpoint that re-seats an unsold show, the buyer's seat map - but an organizer
 * looking at their event could not find any of it: the Sessions table said "Reserved seating"
 * and a room name, nothing said which layout VERSION a show uses, and a "Change" link was
 * offered on shows that had already sold, which could only fail.
 *
 * This page is a view onto that one engine, not a second one. Per show it says the kind,
 * the space, the pinned version, the categories and prices, what is sold and held, a preview
 * of exactly what a buyer sees, and - where the answer is no - why seating cannot change.
 * Changes go through `updateSessionSeating` (which refuses past the first sale or hold) and the
 * Tickets page; seat holds go to cinema live operations. Nothing here writes on its own.
 */
export default function SeatingPage() {
  const { id } = useParams<{ id: string }>();
  const [filter, setFilter] = useState<SessionFilter>('upcoming');
  const [shown, setShown] = useState(PAGE);
  const [previewing, setPreviewing] = useState<EventSession | null>(null);
  const [changing, setChanging] = useState<EventSession | null>(null);

  const eventQ = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const event = eventQ.data;
  const orgId = event?.organizationId;

  // Every space in the organization: which cinema owns a screen, and each layout's CURRENT version.
  const spaces = useQuery({
    queryKey: ['org-spaces', orgId],
    queryFn: () => api.venues.allSpaces(orgId!),
    enabled: !!orgId,
  });
  // The choices the change dialog offers - the same rule the server applies to a change.
  const rooms = useQuery({
    queryKey: ['seating-rooms', orgId],
    queryFn: () => api.events.seatingRooms(orgId!),
    enabled: !!orgId,
  });

  const now = useMemo(() => Date.now(), []);
  const sessions = useMemo(() => event?.sessions ?? [], [event]);

  /*
    Each space's layout versions, once per space rather than per show: which version a show
    is pinned to, its status, and whether a newer one has been published since. Where a list
    cannot be read, the pinned layout's own preview read still names its version.
  */
  const screenIds = useMemo(
    () => [...new Set(sessions.map((s) => s.screenId).filter((x): x is string => !!x))],
    [sessions],
  );
  const layoutLists = useQueries({
    queries: screenIds.map((screenId) => ({
      queryKey: ['screen-layouts', screenId],
      queryFn: () => api.theaterOps.layouts(screenId),
      retry: false,
    })),
  });
  const listFor = new Map<string, LayoutRow[] | undefined>();
  const failedScreens = new Set<string>();
  screenIds.forEach((screenId, i) => {
    listFor.set(screenId, layoutLists[i]?.data);
    if (layoutLists[i]?.isError) failedScreens.add(screenId);
  });
  const fallbackIds = [
    ...new Set(
      sessions
        .filter((s) => s.screenId && s.seatMapId && failedScreens.has(s.screenId))
        .map((s) => s.seatMapId as string),
    ),
  ];
  const fallbackReads = useQueries({
    queries: fallbackIds.map((layoutId) => ({
      queryKey: ['layout-preview', layoutId],
      queryFn: () => api.theaterOps.previewLayout(layoutId),
      retry: false,
    })),
  });
  const fallback = new Map<string, LayoutVersion>();
  fallbackIds.forEach((layoutId, i) => {
    const p = fallbackReads[i]?.data?.preview;
    if (p)
      fallback.set(layoutId, { id: layoutId, name: p.name, version: p.version, status: p.status });
  });

  if (eventQ.isError)
    return (
      <ErrorState
        message="We couldn't load this event. Please try again."
        onRetry={() => eventQ.refetch()}
      />
    );
  if (!event) return <Skeleton className="h-96 w-full" />;

  const seatingFor = (s: EventSession) => {
    const space = spaceFor(s, spaces.data);
    const { layout, newer } = resolveLayout(
      s.seatMapId,
      s.screenId ? listFor.get(s.screenId) : undefined,
      s.seatMapId ? fallback.get(s.seatMapId) : undefined,
    );
    return sessionSeating({ session: s, space, layout, newer, now });
  };

  const list = filterSessions(sessions, filter, now);
  const visible = list.slice(0, shown);
  const counts = {
    upcoming: filterSessions(sessions, 'upcoming', now).length,
    past: filterSessions(sessions, 'past', now).length,
    all: sessions.length,
  };
  const previewSeating = previewing ? seatingFor(previewing) : null;

  return (
    <div className="min-w-0 space-y-5">
      <section
        aria-labelledby="seating-title"
        className="rounded-lg border border-border bg-background-surface p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-prose">
            <h2 id="seating-title" className="text-title font-semibold text-text-primary">
              Seating
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              <span className="font-medium text-text-primary">{seatingMix(sessions)}.</span> Each
              reserved-seating show uses one version of a space&rsquo;s layout. You can move a show
              to another space or layout until its first seat is sold or held; after that its layout
              is locked, so nobody&rsquo;s paid seat moves.
            </p>
          </div>
          <Link
            href={`/organizer/events/${id}/sessions`}
            className="inline-flex h-9 items-center rounded-md border border-border-input px-3 text-sm font-medium text-text-primary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Add a session
          </Link>
        </div>
        <p className="mt-3 text-caption text-text-muted">
          Spaces and their layouts are built under{' '}
          <Link href="/organizer/venues" className="underline hover:text-text-primary">
            Venues &amp; seating
          </Link>
          . Prices per category are edited on{' '}
          <Link
            href={`/organizer/events/${id}/tickets`}
            className="underline hover:text-text-primary"
          >
            Tickets
          </Link>
          .
        </p>
      </section>

      {sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          hint="Add a session and choose general admission or a space with a seat map."
          action={
            <Link
              href={`/organizer/events/${id}/sessions`}
              className="font-medium text-action-primary underline"
            >
              Add a session
            </Link>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl<SessionFilter>
              label="Show sessions"
              value={filter}
              onChange={(v) => {
                setFilter(v);
                setShown(PAGE);
              }}
              options={[
                { value: 'upcoming', label: `To come (${counts.upcoming})` },
                { value: 'past', label: `Past (${counts.past})` },
                { value: 'all', label: `All (${counts.all})` },
              ]}
            />
            {spaces.isError ? (
              <p className="text-caption text-text-muted">
                We could not load your spaces, so cinema ownership may be missing below.
              </p>
            ) : null}
          </div>

          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
              {filter === 'upcoming' ? 'Nothing still to come.' : 'No past sessions.'}
            </p>
          ) : (
            <ul className="space-y-3" aria-label="Sessions and their seating">
              {visible.map((s) => (
                <li key={s.id}>
                  <SessionSeatingCard
                    sessionId={s.id}
                    eventId={id}
                    when={timeAtVenue(s.startsAt, event.venue)}
                    status={s.status}
                    seating={seatingFor(s)}
                    onPreview={() => setPreviewing(s)}
                    onChange={() => setChanging(s)}
                  />
                </li>
              ))}
            </ul>
          )}
          {list.length > visible.length ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, list.length - visible.length)} more of{' '}
                {list.length - visible.length}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {previewing && previewing.seatMapId ? (
        <SeatMapPreviewDialog
          open
          onClose={() => setPreviewing(null)}
          sessionId={previewing.id}
          seatMapId={previewing.seatMapId}
          // The public seat read serves published events only; anything else previews the layout.
          live={event.status === 'PUBLISHED' && previewing.status !== 'CANCELLED'}
          title={`Buyer seat map: ${timeAtVenue(previewing.startsAt, event.venue)}`}
          layoutText={layoutLabel(previewSeating?.layout ?? null)}
        />
      ) : null}

      <ChangeSeatingDialog
        eventId={id}
        session={changing}
        rooms={rooms.data}
        roomsFailed={rooms.isError}
        roomsLoading={rooms.isLoading}
        whenLabel={changing ? timeAtVenue(changing.startsAt, event.venue) : ''}
        onClose={() => setChanging(null)}
      />
    </div>
  );
}
