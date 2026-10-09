'use client';

import { CalendarDays, MapPin } from 'lucide-react';
import type { OrgEventDetail } from '@eticketsgo/web-kit';
import { EventArtwork } from './event-artwork';
import { EventStateBadges } from './event-state-badges';
import { timeAtVenue } from './event-list-model';
import { sessionBreakdown } from './event-overview-model';

/**
 * Which event this is, on every page of it: picture, title, where it stands, where and when.
 *
 * Above the section navigation, so moving from Tickets to Orders never loses sight of which
 * event the page is about. The title wraps - a 120-character title takes two or three lines
 * rather than a horizontal scroll - and so does the venue line.
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

  return (
    <header className="flex min-w-0 items-start gap-3 sm:gap-4">
      <EventArtwork
        id={event.id}
        title={event.title}
        imagePath={event.imagePath}
        imageVariants={event.imageVariants}
        use="thumb"
        className="h-14 w-14 rounded-lg text-2xl sm:h-20 sm:w-20 sm:text-3xl"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-caption font-medium uppercase tracking-wide text-text-muted">
          {event.category}
        </p>
        <h1 className="break-words text-h3 font-bold leading-tight text-text-primary sm:text-h2">
          {event.title}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <EventStateBadges event={event} />
          {/*
            Whose event this is, when it is not the organization the switcher is on.

            An event is reachable by link as well as by browsing, so somebody can be looking at
            one organization's event while the console is set to another - and every action on
            this page would then read as belonging to the wrong one. Named only when they differ,
            so the ordinary case stays quiet.
          */}
          {ownerNote ? (
            <span className="rounded-full bg-tint-warning px-3 py-0.5 text-caption font-medium text-status-warning">
              {ownerNote}
            </span>
          ) : null}
        </div>
        <ul className="space-y-0.5 text-[0.875rem] text-text-secondary">
          <li className="flex min-w-0 items-start gap-1.5">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
            <span className="min-w-0 break-words">
              <span className="sr-only">Venue: </span>
              {event.venue.name}, {event.venue.city}
            </span>
          </li>
          <li className="flex min-w-0 items-start gap-1.5">
            <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
            <span className="min-w-0 break-words">
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
        </ul>
      </div>
    </header>
  );
}
