'use client';

import Link from 'next/link';
import { CalendarDays, MapPin } from 'lucide-react';
import {
  ImageFrame,
  ProgressMeter,
  SellingPill,
  StatusPill,
  eventImageSource,
  money,
  type SellingState,
} from '@eticketsgo/web-kit';
import { EventStatePill } from './event-state-badges';
import { EventActions } from './event-actions';
import { imageCategoryOf, scheduleSummary, type EventListRow } from './event-list-model';

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

/** Sold against capacity: the design system's meter, "45 / 100 sold" and the percentage. */
export function SoldMeter({ event }: { event: EventListRow }) {
  const sold = event.tickets?.sold ?? 0;
  const capacity = event.tickets?.capacity ?? 0;
  return (
    <ProgressMeter
      value={sold}
      max={capacity}
      size="sm"
      label={capacity > 0 ? `${sold} of ${capacity} sold` : `${sold} sold`}
    />
  );
}

/**
 * Whether the event is selling, as the server said - or that it is still being asked, or
 * could not be. Never "Selling" without an answer that says so.
 */
export function SaleStatePill({
  selling,
  unavailable,
}: {
  selling: SellingState | null | undefined;
  /** The question failed, or this member may not ask it. */
  unavailable?: boolean;
}) {
  if (selling) return <SellingPill {...selling} size="sm" />;
  return (
    <StatusPill tone="neutral" size="sm" dot={false}>
      {unavailable ? 'Sale status unavailable' : 'Checking sale status'}
    </StatusPill>
  );
}

/** The picture for a list's card, in the sizes the API keeps. */
export function cardImage(event: Pick<EventListRow, 'imagePath' | 'imageVariants'>) {
  const image = { variants: event.imageVariants, path: event.imagePath };
  return eventImageSource(image, 'card') ?? eventImageSource(image, 'banner');
}

/**
 * One event as the reference's compact card: the artwork in a fixed frame with the lifecycle
 * pill on it, the title, when and where, how it is selling, sold against capacity, and one
 * tinted "Manage" beside a square "..." menu.
 *
 * ── WHY THE FRAME IS FIXED ────────────────────────────────────────────────────────
 * Uploads are posters, squares and panoramas. A box that took the picture's own shape made
 * every row of cards a different height. The frame is 16:9 (21:9 on a phone, where 16:9 would
 * fill half the screen) and the picture is cropped to it; no picture, or one that fails to
 * load, draws the branded placeholder - never a broken-image icon, never a stretched picture.
 *
 * ── WHY THE FOOTER IS PINNED ──────────────────────────────────────────────────────
 * A title on one line and one on two would put the meters and buttons of neighbouring cards at
 * different heights. The body grows; the meter and the actions sit at the bottom of every card.
 */
export function EventCard({
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
  /** The first row on screen loads its pictures eagerly. */
  priority?: boolean;
}) {
  const schedule = scheduleSummary(event);
  const href = `/organizer/events/${event.id}`;
  const source = cardImage(event);
  const titleId = `event-${event.id}-title`;
  return (
    /*
      No `overflow-hidden` on the card: it clipped the More menu. The frame rounds its own top
      corners instead. And no `transform` on hover, only the shadow: a transformed card becomes
      the containing block of the menu's `position: fixed`, and the next card then painted over
      the open menu - the hover that lifted the card was the one that buried its menu.
    */
    <article
      aria-labelledby={titleId}
      className="relative flex w-full min-w-0 flex-col rounded-lg border border-border bg-background-surface shadow-xs transition-shadow duration-150 hover:shadow-md motion-reduce:transition-none"
    >
      <ImageFrame
        src={source?.src}
        srcSet={source?.srcSet}
        sizes="(min-width: 1280px) 280px, (min-width: 640px) 33vw, 100vw"
        alt=""
        ratio="16:9"
        category={imageCategoryOf(event.category)}
        priority={priority}
        rounded="none"
        className="rounded-t-lg border-b border-border max-[479px]:aspect-[21/9]"
        overlay={<EventStatePill event={event} />}
      />
      <div className="flex min-w-0 flex-1 flex-col p-3.5">
        <h2
          id={titleId}
          className="line-clamp-2 break-words font-display text-[0.9375rem] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]"
          title={event.title}
        >
          <Link
            href={href}
            className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-surface"
          >
            {event.title}
          </Link>
        </h2>

        <dl className="mt-2 min-w-0 space-y-1 text-caption text-text-secondary">
          <div className="flex min-w-0 items-start gap-1.5">
            <dt className="mt-[3px] shrink-0">
              <CalendarDays className="h-3.5 w-3.5 text-text-muted" aria-hidden />
              <span className="sr-only">Schedule</span>
            </dt>
            <dd className="min-w-0">
              {schedule.lead === 'Next' ? <span className="sr-only">Next: </span> : null}
              {schedule.lead === 'Last' ? <span className="text-text-muted">Last: </span> : null}
              <span className="tabular-nums">{schedule.when}</span>
              {schedule.more ? (
                <span className="block text-text-muted">{schedule.more}</span>
              ) : null}
            </dd>
          </div>
          <div className="flex min-w-0 items-start gap-1.5">
            <dt className="mt-[3px] shrink-0">
              <MapPin className="h-3.5 w-3.5 text-text-muted" aria-hidden />
              <span className="sr-only">Venue</span>
            </dt>
            <dd className="min-w-0 truncate" title={`${event.venue.name}, ${event.venue.city}`}>
              {event.venue.name}, {event.venue.city}
            </dd>
          </div>
        </dl>

        <div className="mt-2.5 flex min-w-0">
          <SaleStatePill selling={selling} unavailable={saleUnavailable} />
        </div>

        <div className="mt-auto space-y-2.5 pt-3">
          <SoldMeter event={event} />
          {event.sales ? (
            <div className="flex min-w-0 items-baseline justify-between gap-2 border-t border-border pt-2 text-caption">
              <span className="text-text-muted">Gross sales</span>
              <span className="min-w-0 text-right">
                <SalesLines event={event} />
              </span>
            </div>
          ) : null}
          <EventActions
            event={event}
            fill
            duplicating={duplicating}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
          />
        </div>
      </div>
    </article>
  );
}
