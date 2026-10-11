'use client';

import Link from 'next/link';
import {
  Building2,
  CalendarDays,
  CalendarPlus,
  Film,
  MapPin,
  Mic,
  Music,
  Presentation,
  Sparkles,
  Ticket,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import {
  ButtonLink,
  EmptyState,
  IconTile,
  ImageFrame,
  LifecyclePill,
  Menu,
  ProgressMeter,
  eventImageSource,
  lifecycleOf,
  type ImageCategory,
  type OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import { formatClock, sessionZone } from '@/lib/calendar';
import { zoneShortName, type EventListRow } from '@/components/events/event-list-model';
import type { Selling } from './status';
import { venueDay } from './model';
import { SaleStatePill, categoryOf, shortDay } from './upcoming-events';

/*
  The category's own icon, for an event with no artwork of its own. The mapping is the one the
  branded placeholder uses; it is repeated here because that table is private to the image frame.
*/
const CATEGORY_ICON: Record<ImageCategory, LucideIcon> = {
  event: Ticket,
  movie: Film,
  venue: Building2,
  music: Music,
  comedy: Mic,
  sports: Trophy,
  conference: Presentation,
  other: Sparkles,
};

/** Whether an event has artwork of its own (uploaded), as opposed to the drawn placeholder. */
export function hasOwnArtwork(row: EventListRow | undefined): boolean {
  return !!row && !!(row.imagePath || row.imageVariants);
}

function facts(show: OrganizerCalendarSession, row?: EventListRow) {
  const { zone } = sessionZone(show);
  const day = venueDay(show);
  const more = Math.max(0, (row?.schedule?.upcomingSessions ?? 1) - 1);
  return {
    day,
    href: `/organizer/events/${show.event.id}`,
    when: `${shortDay(day)}, ${formatClock(show.startsAt, zone)} ${zoneShortName(show.startsAt, zone)}`,
    more,
    where: `${show.venue.name}${show.venue.city ? `, ${show.venue.city}` : ''}`,
  };
}

function EventMenu({
  show,
  href,
  day,
}: {
  show: OrganizerCalendarSession;
  href: string;
  day: string;
}) {
  return (
    <Menu
      trigger="icon"
      label={`More actions for ${show.event.title}`}
      align="end"
      items={[
        { kind: 'link', label: 'Orders', href: `${href}/orders` },
        { kind: 'link', label: 'Attendees', href: `${href}/attendees` },
        { kind: 'link', label: 'Shows and dates', href: `${href}/sessions` },
        { kind: 'separator' },
        {
          kind: 'link',
          label: 'See this day on the calendar',
          href: `/organizer/calendar?view=day&date=${day}`,
        },
      ]}
    />
  );
}

function SoldMeter({ show }: { show: OrganizerCalendarSession }) {
  return show.sold != null ? (
    <ProgressMeter
      value={show.sold}
      max={show.capacity ?? 0}
      size="sm"
      label={`${show.event.title}, next show: ${show.sold} of ${show.capacity ?? 0} sold`}
    />
  ) : (
    <p className="text-micro text-text-muted">No tickets on this show yet</p>
  );
}

/**
 * The only upcoming event: one card across the width, so a single event is not a lone small card
 * with a screen of nothing beside it. Artwork on the left when the event has its own; otherwise a
 * category icon tile - one placeholder at 22rem wide would be the "repeated artwork" it replaces.
 */
export function FeaturedEventCard({
  show,
  row,
  selling,
  priority,
}: {
  show: OrganizerCalendarSession;
  row?: EventListRow;
  selling: Selling;
  priority?: boolean;
}) {
  const f = facts(show, row);
  const lifecycle = lifecycleOf(show.event.status);
  const category = categoryOf(show.event.category, show.event.experienceType);
  const image = hasOwnArtwork(row)
    ? eventImageSource({ variants: row!.imageVariants, path: row!.imagePath }, 'card')
    : null;
  const titleId = `upcoming-${show.event.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs md:flex-row md:transition-shadow md:duration-150 md:hover:shadow-md motion-reduce:transition-none"
    >
      {image ? (
        <div className="md:w-[19rem] md:shrink-0 lg:w-[22rem]">
          <ImageFrame
            src={image.src}
            srcSet={image.srcSet}
            sizes="(min-width: 1024px) 352px, (min-width: 768px) 304px, 100vw"
            alt=""
            ratio="16:9"
            category={category}
            priority={priority}
            className="rounded-none max-md:!aspect-[21/9] md:h-full"
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          {!image ? (
            <IconTile icon={CATEGORY_ICON[category]} tone="teal" size="lg" className="shrink-0" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {lifecycle ? <LifecyclePill status={lifecycle} size="sm" /> : null}
              <SaleStatePill selling={selling} size="sm" />
            </div>
            <h3
              id={titleId}
              className="mt-1.5 line-clamp-2 break-words font-display text-title font-bold leading-snug text-text-primary"
              title={show.event.title}
            >
              <Link
                href={f.href}
                className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {show.event.title}
              </Link>
            </h3>
            <dl className="mt-1.5 space-y-1 text-caption text-text-secondary">
              <div className="flex min-w-0 items-center gap-2">
                <dt>
                  <CalendarDays className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                  <span className="sr-only">Next show</span>
                </dt>
                <dd className="min-w-0 truncate tabular-nums">
                  {f.when}
                  {f.more > 0 ? (
                    <span className="text-text-muted">
                      {' '}
                      +{f.more} more {f.more === 1 ? 'show' : 'shows'}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <dt>
                  <MapPin className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                  <span className="sr-only">Venue</span>
                </dt>
                <dd className="min-w-0 truncate" title={f.where}>
                  {f.where}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="mt-auto flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-[12rem] flex-1">
            <SoldMeter show={show} />
          </div>
          <div className="flex items-center gap-2">
            <ButtonLink href={f.href} variant="tinted" size="sm">
              Manage
            </ButtonLink>
            <EventMenu show={show} href={f.href} day={f.day} />
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * One upcoming event as a compact row: a category icon (or its small cover), the title, date and
 * venue, the two pills, how full the next show is, and Manage. About 4rem tall on a desktop where
 * an image card is 20rem, so many events do not become a long page of the same picture.
 */
export function EventRow({
  show,
  row,
  selling,
}: {
  show: OrganizerCalendarSession;
  row?: EventListRow;
  selling: Selling;
}) {
  const f = facts(show, row);
  const lifecycle = lifecycleOf(show.event.status);
  const category = categoryOf(show.event.category, show.event.experienceType);
  const image = hasOwnArtwork(row)
    ? eventImageSource({ variants: row!.imageVariants, path: row!.imagePath }, 'card')
    : null;
  const titleId = `upcoming-${show.event.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4 lg:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
    >
      {image ? (
        <ImageFrame
          src={image.src}
          srcSet={image.srcSet}
          sizes="48px"
          alt=""
          ratio="1:1"
          category={category}
          placeholderLabel=""
          rounded="md"
          className="!w-12"
        />
      ) : (
        <IconTile icon={CATEGORY_ICON[category]} tone="teal" size="lg" className="!h-12 !w-12" />
      )}
      <div className="min-w-0">
        <h3
          id={titleId}
          className="truncate font-display text-ui font-bold leading-snug text-text-primary"
          title={show.event.title}
        >
          <Link
            href={f.href}
            className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {show.event.title}
          </Link>
        </h3>
        <p className="truncate text-caption tabular-nums text-text-secondary" title={f.where}>
          <span className="sr-only">Next show: </span>
          {f.when}
          <span aria-hidden> - </span>
          <span className="sr-only">at </span>
          {f.where}
          {f.more > 0 ? <span className="text-text-muted"> +{f.more} more</span> : null}
        </p>
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 lg:col-span-1 lg:max-w-[11rem] lg:flex-col lg:items-start">
        {lifecycle ? <LifecyclePill status={lifecycle} size="sm" /> : null}
        <SaleStatePill selling={selling} size="sm" />
      </div>
      <div className="col-span-2 flex items-center gap-3 lg:col-span-1">
        <div className="min-w-0 flex-1 lg:w-32 lg:flex-none">
          <SoldMeter show={show} />
        </div>
        <ButtonLink href={f.href} variant="tinted" size="sm">
          Manage
        </ButtonLink>
        <EventMenu show={show} href={f.href} day={f.day} />
      </div>
    </article>
  );
}

/**
 * Nothing published is coming up. Say so, and put the next useful step in reach: the newest draft
 * to carry on with, and Create event. A page that has nothing to show is a page that should say
 * what to do, not leave a hole.
 */
export function NoUpcomingEvents({
  canCreate,
  draft,
  later = 0,
}: {
  canCreate: boolean;
  draft: { id: string; title: string } | null;
  /** Published events whose next show is further out than the page's four-week window. */
  later?: number;
}) {
  return (
    <EmptyState
      compact
      icon={CalendarPlus}
      tone="teal"
      title={later > 0 ? 'Nothing in the next four weeks' : 'No published events coming up'}
      hint={
        later > 0
          ? `${later} published ${later === 1 ? 'event has its' : 'events have their'} next show later than that.`
          : draft
            ? 'Events appear here once they are published and have a date still to come. You have a draft you can carry on with.'
            : 'Events appear here once they are published and have a date still to come, with how each one is selling.'
      }
      action={
        draft ? (
          <ButtonLink href={`/organizer/events/${draft.id}`} variant="tinted" size="sm">
            Continue your draft
          </ButtonLink>
        ) : canCreate ? (
          <ButtonLink href="/organizer/events/new" variant="tinted" size="sm">
            Create an event
          </ButtonLink>
        ) : undefined
      }
      secondaryAction={
        draft && canCreate && later === 0 ? (
          <Link
            href="/organizer/events/new"
            className="rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Create an event
          </Link>
        ) : (
          <Link
            href="/organizer/events"
            className="rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            See all events
          </Link>
        )
      }
    />
  );
}
