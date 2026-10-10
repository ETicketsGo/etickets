'use client';

import Link from 'next/link';
import { CalendarDays, MapPin } from 'lucide-react';
import { ImageFrame, type SellingState } from '@eticketsgo/web-kit';
import { EventStatePill } from './event-state-badges';
import { EventActions } from './event-actions';
import { SaleStatePill, SoldMeter, cardImage } from './event-card';
import { imageCategoryOf, scheduleSummary, type EventListRow } from './event-list-model';

/**
 * One event as a phone's compact row: a square thumbnail beside the title, when and where,
 * and the stage and sale pills, then a thin sold meter beside "Manage" and the "..." menu.
 * About 140px, so four and more fit an 844px screen where the image card fit one.
 *
 * The same facts and the same controls as `EventCard`, from the same pieces (the pills, the
 * meter, the actions), so the two can never disagree; only the gross sales line is left to
 * the event page and the wider screens' table, because a money figure squeezed into a phone
 * row next to "2 / 12 sold" reads as the price of those tickets.
 */
export function EventCardCompact({
  event,
  selling,
  saleUnavailable,
  duplicating,
  onDuplicate,
  onDelete,
  priority = false,
}: {
  event: EventListRow;
  /** The server's unified sale state for this event; null while it is being asked. */
  selling: SellingState | null;
  saleUnavailable?: boolean;
  duplicating: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  /** The first rows on screen load their pictures eagerly. */
  priority?: boolean;
}) {
  const schedule = scheduleSummary(event);
  const href = `/organizer/events/${event.id}`;
  const source = cardImage(event);
  const titleId = `event-${event.id}-title`;
  const where = `${event.venue.name}, ${event.venue.city}`;
  return (
    // No `overflow-hidden` and no hover transform: either one traps or buries the More menu.
    <article
      aria-labelledby={titleId}
      className="relative w-full min-w-0 rounded-lg border border-border bg-background-surface p-2.5 shadow-xs"
    >
      <div className="flex min-w-0 gap-3">
        <ImageFrame
          src={source?.src}
          srcSet={source?.srcSet}
          sizes="80px"
          alt=""
          ratio="1:1"
          category={imageCategoryOf(event.category)}
          priority={priority}
          rounded="md"
          className="!w-14 shrink-0 self-start"
        />
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="line-clamp-2 break-words font-display text-ui font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]"
            title={event.title}
          >
            <Link
              href={href}
              className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-surface"
            >
              {event.title}
            </Link>
          </h2>
          <dl className="mt-0.5 min-w-0 text-caption leading-snug text-text-secondary">
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0">
                <CalendarDays className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                <span className="sr-only">Schedule</span>
              </dt>
              <dd className="min-w-0 truncate">
                {schedule.lead === 'Next' ? <span className="sr-only">Next: </span> : null}
                {schedule.lead === 'Last' ? <span className="text-text-muted">Last: </span> : null}
                <span className="tabular-nums">{schedule.when}</span>
                {schedule.more ? <span className="text-text-muted">, {schedule.more}</span> : null}
              </dd>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0">
                <MapPin className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                <span className="sr-only">Venue</span>
              </dt>
              <dd className="min-w-0 truncate" title={where}>
                {where}
              </dd>
            </div>
          </dl>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
            <EventStatePill event={event} />
            <SaleStatePill selling={selling} unavailable={saleUnavailable} />
          </div>
        </div>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <SoldMeter event={event} />
        </div>
        <EventActions
          event={event}
          size="sm"
          duplicating={duplicating}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}
