'use client';

import Link from 'next/link';
import { CalendarDays, MapPin } from 'lucide-react';
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
    <div className={compact ? 'min-w-[6rem]' : 'min-w-0'}>
      <p className="tabular-nums text-text-primary">
        {label}
        {percent !== null ? <span className="text-text-muted"> sold ({percent}%)</span> : null}
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
 * One event as a compact card: a picture band, then what it is, where and when, and how it is
 * selling, with one "Manage" button and a labelled "More" menu.
 *
 * ── WHY THE BAND IS SHORT ─────────────────────────────────────────────────────────
 * The 4:3 picture took 180-260px of every card, so three events filled a laptop screen and the
 * picture - often a placeholder letter - was most of what anyone saw. The band is 128px high
 * at every width: enough to recognise the poster, and the facts an organizer acts on (stage,
 * next date, sold) come up into the first glance.
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
    /*
      No `overflow-hidden` here: it clipped the More menu to the card. The picture band rounds
      its own top corners instead.
    */
    <article
      aria-labelledby={`event-${event.id}-title`}
      className="flex w-full min-w-0 flex-col rounded-lg border border-border bg-background-surface transition-shadow duration-150 hover:shadow-md motion-reduce:transition-none"
    >
      <EventArtwork
        category={event.category}
        imagePath={event.imagePath}
        imageVariants={event.imageVariants}
        use="card"
        sizes="(min-width: 1280px) 360px, (min-width: 640px) 50vw, 100vw"
        className="h-32 w-full rounded-t-lg"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-4">
        <div className="min-w-0 space-y-1.5">
          <p className="min-w-0 truncate text-caption font-medium uppercase tracking-wide text-text-muted">
            {event.category}
          </p>
          <h2
            id={`event-${event.id}-title`}
            className="line-clamp-2 break-words text-base font-semibold leading-snug text-text-primary"
            title={event.title}
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

        <dl className="min-w-0 space-y-1 text-[0.8125rem] text-text-secondary">
          <div className="flex min-w-0 items-start gap-2">
            <dt className="mt-0.5 shrink-0">
              <MapPin className="h-3.5 w-3.5 text-text-muted" aria-hidden />
              <span className="sr-only">Venue</span>
            </dt>
            <dd className="min-w-0 truncate" title={`${event.venue.name}, ${event.venue.city}`}>
              {event.venue.name}, {event.venue.city}
            </dd>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <dt className="mt-0.5 shrink-0">
              <CalendarDays className="h-3.5 w-3.5 text-text-muted" aria-hidden />
              <span className="sr-only">Schedule</span>
            </dt>
            <dd className="min-w-0 break-words">
              {schedule.lead ? <span className="text-text-muted">{schedule.lead}: </span> : null}
              <span className="tabular-nums">{schedule.when}</span>
              {schedule.more ? <span className="text-text-muted"> ({schedule.more})</span> : null}
            </dd>
          </div>
        </dl>

        <div className="mt-auto flex min-w-0 items-end justify-between gap-3 border-t border-border pt-2.5 text-[0.8125rem]">
          <div className="min-w-0 flex-1">
            <span className="sr-only">Tickets: </span>
            <SoldMeter event={event} />
          </div>
          {event.sales ? (
            <div className="shrink-0 text-right">
              <span className="block text-caption text-text-muted">Gross</span>
              <SalesLines event={event} />
            </div>
          ) : null}
        </div>

        <EventActions
          event={event}
          fill
          duplicating={duplicating}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}
