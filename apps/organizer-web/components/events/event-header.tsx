'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, MapPin } from 'lucide-react';
import { api, ImageFrame, ProgressMeter, type OrgEventDetail } from '@eticketsgo/web-kit';
import { EventStateBadges } from './event-state-badges';
import { SaleStatePill, cardImage } from './event-card';
import { imageCategoryOf, sellingStateOf, timeAtVenue } from './event-list-model';
import { sessionBreakdown, ticketTotals } from './event-overview-model';

/**
 * The server's unified sale state for one event - the query the overview shares, by key, so
 * the header and the overview's next step are one request and one answer.
 */
export function useEventSaleState(eventId: string, organizationId: string | undefined) {
  return useQuery({
    queryKey: ['organizer-event-sale-states', organizationId, eventId],
    queryFn: () => api.events.saleStates(organizationId!, [eventId]),
    enabled: !!organizationId,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Which event this is, on every page of it: the artwork, the title, where it is in its life,
 * whether it is selling, and the facts an organizer checks first - when, where, how full.
 *
 * Above the section navigation, so moving from Tickets to Orders never loses sight of which
 * event the page is about. The title wraps - a 120-character title takes two or three lines
 * rather than a horizontal scroll - and so does the venue line.
 *
 * ── WHY STAGE AND SALES ARE BOTH HERE ─────────────────────────────────────────────
 * They answer different questions ("has it been approved", "can a buyer buy right now") and a
 * paused or partly selling event needs both to be read correctly. Sales is the server's one
 * answer, the same the list and the Overview dashboard show; while it is being asked the pill
 * says so, never "Selling".
 */
export function EventHeader({
  event,
  ownerNote,
}: {
  event: OrgEventDetail;
  /** "In <organization>", when the event is not the switcher's organization's. */
  ownerNote: string | null;
}) {
  const { upcoming } = sessionBreakdown(event.sessions, Date.now());
  const next = upcoming[0];
  const last = [...event.sessions]
    .filter((s) => s.status !== 'CANCELLED')
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  const more = upcoming.length - 1;
  const totals = ticketTotals(event.sessions);
  const saleQ = useEventSaleState(event.id, event.organizationId);
  const answer = saleQ.data?.events.find((e) => e.eventId === event.id);
  const source = cardImage(event);

  return (
    <header className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-background-surface p-3 shadow-xs sm:gap-5 sm:p-4">
      <div className="w-16 shrink-0 sm:w-52 lg:w-60">
        <ImageFrame
          src={source?.src}
          srcSet={source?.srcSet}
          sizes="(min-width: 1024px) 240px, (min-width: 640px) 208px, 64px"
          alt=""
          ratio="16:9"
          category={imageCategoryOf(event.category)}
          priority
          rounded="md"
          className="max-sm:aspect-square"
        />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="min-w-0">
          <p className="truncate text-micro font-semibold uppercase tracking-wider text-text-muted">
            {event.category}
          </p>
          <h1 className="break-words font-display text-[1.25rem] font-bold leading-tight text-text-primary [overflow-wrap:anywhere] sm:text-headline">
            {event.title}
          </h1>
        </div>
        {/*
          A definition list so a screen reader hears "Stage, Published; Sales, Selling" rather
          than two unexplained words; the terms are visible to it only, the pills say enough.
        */}
        <dl className="flex flex-wrap items-center gap-1.5">
          <div className="flex min-w-0 max-w-full items-center">
            <dt className="sr-only">Stage</dt>
            <dd className="min-w-0 max-w-full">
              <EventStateBadges event={event} />
            </dd>
          </div>
          <div className="flex min-w-0 max-w-full items-center">
            <dt className="sr-only">Sales</dt>
            <dd className="min-w-0 max-w-full">
              <SaleStatePill selling={sellingStateOf(answer)} unavailable={saleQ.isError} />
            </dd>
          </div>
          {/*
            Whose event this is, when it is not the organization the switcher is on. An event is
            reachable by link as well as by browsing, so somebody can be looking at one
            organization's event while the console is set to another - and every action on this
            page would then read as belonging to the wrong one.
          */}
          {ownerNote ? (
            <div className="flex items-center">
              <dt className="sr-only">Organization</dt>
              <dd className="rounded-full bg-tint-warning px-2.5 py-0.5 text-micro font-semibold text-status-warning">
                {ownerNote}
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="grid min-w-0 gap-x-6 gap-y-1.5 text-caption text-text-secondary sm:text-ui xl:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)] xl:items-end">
          <ul className="min-w-0 space-y-1">
            <li className="flex min-w-0 items-start gap-1.5">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
              <span className="min-w-0 break-words tabular-nums">
                {next ? (
                  <>
                    <span className="text-text-muted">Next: </span>
                    {timeAtVenue(next.startsAt, event.venue)}
                    {more > 0 ? (
                      <span className="text-text-muted">
                        {' '}
                        (+{more} more session{more === 1 ? '' : 's'})
                      </span>
                    ) : null}
                  </>
                ) : last ? (
                  <>
                    <span className="text-text-muted">Last session: </span>
                    {timeAtVenue(last.startsAt, event.venue)}
                  </>
                ) : (
                  'No sessions yet'
                )}
              </span>
            </li>
            <li className="flex min-w-0 items-start gap-1.5">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
              <span className="min-w-0 break-words">
                <span className="sr-only">Venue: </span>
                {event.venue.name}, {event.venue.city}
              </span>
            </li>
          </ul>
          {/* Hidden on a phone: the Overview's Tickets section says it in full right below. */}
          {totals.types > 0 ? (
            <div className="mt-1 hidden min-w-0 sm:block xl:mt-0">
              <p className="mb-1.5 text-micro font-semibold uppercase tracking-wider text-text-muted">
                Tickets, all sessions
              </p>
              <ProgressMeter value={totals.sold} max={totals.capacity} size="sm" />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
