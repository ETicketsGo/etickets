'use client';

import Link from 'next/link';
import { CalendarDays, MapPin, Ticket } from 'lucide-react';
import { money } from '@eticketsgo/web-kit';
import { EventArtwork } from './event-artwork';
import { EventStateBadges } from './event-state-badges';
import { EventActions } from './event-actions';
import { scheduleSummary, soldOfCapacity, type EventListRow } from './event-list-model';

/** The events' sales, one line per currency. Never a total across currencies. */
export function SalesLines({ event }: { event: EventListRow }) {
  if (event.sales === undefined || event.sales === null) return null;
  if (event.isFree) return <span className="text-text-muted">Free event</span>;
  if (event.sales.length === 0) return <span className="text-text-muted">No sales yet</span>;
  return (
    <ul className="space-y-0.5">
      {event.sales.map((s) => (
        <li key={s.currency} className="font-medium tabular-nums text-text-primary">
          {money(s.grossMinor, s.currency)}
        </li>
      ))}
    </ul>
  );
}

/** Sold against capacity, with a bar when there is a capacity to fill. */
export function SoldMeter({ event, compact = false }: { event: EventListRow; compact?: boolean }) {
  const { label, percent } = soldOfCapacity(event.tickets);
  return (
    <div className={compact ? 'min-w-[6rem]' : ''}>
      <p className="tabular-nums text-text-primary">
        {label}
        {percent !== null ? <span className="text-text-muted"> ({percent}%)</span> : null}
      </p>
      {percent !== null ? (
        <div
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-background-subtle"
          aria-hidden="true"
        >
          <div className="h-full rounded-full bg-action-primary" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One event as a card: its picture, what it is, where and when, and how it is selling.
 *
 * Every line that holds somebody's words - the title, the venue - wraps or clamps inside the
 * card. A 120-character title or a venue named in full used to push a fixed-width layout
 * sideways; here the card's width is the grid's, and its text adapts to it.
 */
export function EventCard({
  event,
  duplicating,
  onDuplicate,
  onDelete,
}: {
  event: EventListRow;
  duplicating: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const schedule = scheduleSummary(event);
  const href = `/organizer/events/${event.id}`;
  return (
    <article
      aria-labelledby={`event-${event.id}-title`}
      className="flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm"
    >
      <EventArtwork
        id={event.id}
        title={event.title}
        imagePath={event.imagePath}
        imageVariants={event.imageVariants}
        use="card"
        sizes="(min-width: 1280px) 400px, (min-width: 640px) 50vw, 100vw"
        className="w-full text-5xl"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-caption font-medium uppercase tracking-wide text-text-muted">
            {event.category}
          </p>
          <h2
            id={`event-${event.id}-title`}
            className="line-clamp-2 break-words text-title font-semibold text-text-primary"
          >
            <Link
              href={href}
              className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {event.title}
            </Link>
          </h2>
          <EventStateBadges event={event} />
        </div>

        <dl className="min-w-0 space-y-1.5 text-[0.875rem] text-text-secondary">
          <div className="flex min-w-0 items-start gap-2">
            <dt className="mt-0.5 shrink-0">
              <MapPin className="h-4 w-4 text-text-muted" aria-hidden />
              <span className="sr-only">Venue</span>
            </dt>
            <dd className="line-clamp-2 min-w-0 break-words">
              {event.venue.name}, {event.venue.city}
            </dd>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <dt className="mt-0.5 shrink-0">
              <CalendarDays className="h-4 w-4 text-text-muted" aria-hidden />
              <span className="sr-only">Schedule</span>
            </dt>
            <dd className="min-w-0 break-words">
              {schedule.lead ? <span className="text-text-muted">{schedule.lead}: </span> : null}
              {schedule.when}
              {schedule.more ? (
                <span className="block text-caption text-text-muted">{schedule.more}</span>
              ) : null}
            </dd>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <dt className="mt-0.5 shrink-0">
              <Ticket className="h-4 w-4 text-text-muted" aria-hidden />
              <span className="sr-only">Tickets sold</span>
            </dt>
            <dd className="min-w-0 flex-1">
              <SoldMeter event={event} />
            </dd>
          </div>
          {event.sales ? (
            <div className="flex min-w-0 items-start justify-between gap-3 border-t border-border pt-2">
              <dt className="text-text-muted">Gross sales</dt>
              <dd className="text-right">
                <SalesLines event={event} />
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-auto border-t border-border pt-3">
          <EventActions
            event={event}
            duplicating={duplicating}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
          />
        </div>
      </div>
    </article>
  );
}
