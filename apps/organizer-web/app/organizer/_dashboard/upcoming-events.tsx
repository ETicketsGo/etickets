'use client';

import Link from 'next/link';
import { CalendarDays, CalendarPlus, MapPin } from 'lucide-react';
import {
  ButtonLink,
  EmptyState,
  ImageFrame,
  LifecyclePill,
  Menu,
  ProgressMeter,
  SellingPill,
  eventImageSource,
  lifecycleOf,
  type ImageCategory,
  type OrganizerCalendarSession,
  type SellingState,
} from '@eticketsgo/web-kit';
import { formatClock, sessionZone } from '@/lib/calendar';
import { zoneShortName, type EventListRow } from '@/components/events/event-list-model';
import type { Selling } from './status';
import { venueDay } from './model';

/** The selling sentence as the design system's pill takes it; null while there is no answer. */
export function sellingPillState(selling: Selling): SellingState | null {
  if (selling.state === null) return null;
  if (selling.state === 'SELLING') return { state: 'selling' };
  const reason = selling.label.replace(/^(Partly selling|Not selling):\s*/, '');
  return { state: selling.state === 'PARTIAL' ? 'partly' : 'not', reason };
}

/** The pill, or the honest "Checking sales" / "Sales status unavailable" while it is unknown. */
export function SaleStatePill({ selling, size }: { selling: Selling; size?: 'sm' | 'md' }) {
  const state = sellingPillState(selling);
  if (state) return <SellingPill {...state} size={size} />;
  return (
    <span className="inline-flex items-center rounded-full bg-background-subtle px-2.5 py-0.5 text-micro font-semibold text-text-secondary">
      {selling.label}
    </span>
  );
}

const CATEGORY: Record<string, ImageCategory> = {
  music: 'music',
  comedy: 'comedy',
  sports: 'sports',
  conference: 'conference',
  tech: 'conference',
  film: 'movie',
  movie: 'movie',
};

function categoryOf(category: string, experienceType: string): ImageCategory {
  if (experienceType === 'MOVIE') return 'movie';
  return CATEGORY[category.trim().toLowerCase()] ?? 'event';
}

/** "Sat, 10 Oct" - the show's date at the venue, formatted from its label so it never shifts. */
function shortDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${day}T12:00:00Z`));
}

/**
 * One upcoming event as the reference draws it: its artwork with the lifecycle on top, title,
 * the next show's date and venue, how full that show is, Manage and a "..." menu.
 *
 * ── WHICH NUMBERS ──────────────────────────────────────────────────────────────────
 * The date, the venue and the meter all describe the SAME thing - the event's next show - so
 * "45 / 100 sold" is never a whole run's total sitting under one evening's date. Whether the
 * EVENT is selling is the server's answer over all its upcoming shows (`selling`).
 */
export function UpcomingEventCard({
  show,
  row,
  selling,
  priority = false,
}: {
  show: OrganizerCalendarSession;
  /** The event's row from the event list, for its artwork and how many more shows it has. */
  row?: EventListRow;
  selling: Selling;
  priority?: boolean;
}) {
  const { zone } = sessionZone(show);
  const day = venueDay(show);
  const href = `/organizer/events/${show.event.id}`;
  const lifecycle = lifecycleOf(show.event.status);
  const image = row
    ? eventImageSource({ variants: row.imageVariants, path: row.imagePath }, 'card')
    : null;
  const more = Math.max(0, (row?.schedule?.upcomingSessions ?? 1) - 1);
  const titleId = `upcoming-${show.event.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className="group flex min-w-0 flex-col rounded-lg border border-border bg-background-surface shadow-xs transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <ImageFrame
        src={image?.src}
        srcSet={image?.srcSet}
        sizes="(min-width: 1280px) 300px, (min-width: 768px) 33vw, 80vw"
        alt=""
        ratio="16:9"
        category={categoryOf(show.event.category, show.event.experienceType)}
        priority={priority}
        className="rounded-b-none"
        overlay={lifecycle ? <LifecyclePill status={lifecycle} size="sm" /> : undefined}
      />
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <h3
          id={titleId}
          className="line-clamp-2 break-words font-display text-[0.9375rem] font-bold leading-snug text-text-primary"
          title={show.event.title}
        >
          <Link
            href={href}
            className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {show.event.title}
          </Link>
        </h3>
        <dl className="mt-2 space-y-1 text-caption text-text-secondary">
          <div className="flex min-w-0 items-center gap-2">
            <dt>
              <CalendarDays className="h-3.5 w-3.5 text-text-muted" aria-hidden />
              <span className="sr-only">Next show</span>
            </dt>
            <dd className="min-w-0 truncate tabular-nums">
              {shortDay(day)}, {formatClock(show.startsAt, zone)}{' '}
              {zoneShortName(show.startsAt, zone)}
              {more > 0 ? (
                <span className="text-text-muted">
                  {' '}
                  +{more} more {more === 1 ? 'show' : 'shows'}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <dt>
              <MapPin className="h-3.5 w-3.5 text-text-muted" aria-hidden />
              <span className="sr-only">Venue</span>
            </dt>
            <dd className="min-w-0 truncate" title={`${show.venue.name}, ${show.venue.city}`}>
              {show.venue.name}
              {show.venue.city ? `, ${show.venue.city}` : ''}
            </dd>
          </div>
        </dl>
        <div className="mt-2.5">
          <SaleStatePill selling={selling} size="sm" />
        </div>
        <div className="mt-auto pt-3">
          {show.sold != null ? (
            <ProgressMeter
              value={show.sold}
              max={show.capacity ?? 0}
              size="sm"
              label={`${show.event.title}, next show: ${show.sold} of ${show.capacity ?? 0} sold`}
            />
          ) : (
            <p className="text-micro text-text-muted">No tickets on this show yet</p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <ButtonLink href={href} variant="tinted" size="sm" className="flex-1">
              Manage
            </ButtonLink>
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
          </div>
        </div>
      </div>
    </article>
  );
}

/** Nothing on: say so, and offer the one thing that changes it. */
export function NoUpcomingEvents({ canCreate }: { canCreate: boolean }) {
  return (
    <EmptyState
      compact
      icon={CalendarPlus}
      tone="teal"
      title="No upcoming shows"
      hint="Events with a date still to come appear here, with how each one is selling."
      action={
        canCreate ? (
          <ButtonLink href="/organizer/events/new" variant="tinted" size="sm">
            Create an event
          </ButtonLink>
        ) : undefined
      }
      secondaryAction={
        <Link
          href="/organizer/events"
          className="rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          See all events
        </Link>
      }
    />
  );
}
