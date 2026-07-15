'use client';

import Link from 'next/link';
import {
  Armchair,
  CalendarDays,
  CheckCircle2,
  Clapperboard,
  MapPin,
  Ticket as TicketIcon,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { gradientFor, type BookingGroup, type GroupStatusTone } from '@eticketsgo/web-kit';
import { dateTime } from '@/lib/format';

const TONE_STYLE: Record<
  GroupStatusTone,
  { text: string; dot: string; Icon: typeof CheckCircle2 }
> = {
  success: { text: 'text-status-success', dot: 'bg-status-success', Icon: CheckCircle2 },
  info: { text: 'text-status-info', dot: 'bg-status-info', Icon: CheckCircle2 },
  warning: { text: 'text-status-warning', dot: 'bg-status-warning', Icon: TriangleAlert },
  error: { text: 'text-status-error', dot: 'bg-status-error', Icon: XCircle },
  neutral: { text: 'text-text-secondary', dot: 'bg-text-muted', Icon: TicketIcon },
};

/** One booking rendered as a single group card (replaces per-ticket cards). */
export function BookingGroupCard({ group }: { group: BookingGroup }) {
  const { text, dot, Icon } = TONE_STYLE[group.statusTone];
  const single = group.counts.total === 1;
  const viewerHref = `/account/bookings/${encodeURIComponent(group.bookingId)}/tickets`;

  // Line 2: cinema · screen for movies, else the venue.
  const placeLine = group.isMovie
    ? [group.cinemaName, group.screenName].filter(Boolean).join(' · ') ||
      group.venueName ||
      'Venue TBA'
    : group.venueName || 'Venue TBA';

  // Line 3: seat labels for reserved seating, else the ticket-type summary.
  const seatPreview = group.seatLabels.slice(0, 6).join(', ');
  const detailLine =
    group.seatLabels.length > 0
      ? `Seats ${seatPreview}${group.seatLabels.length > 6 ? ` +${group.seatLabels.length - 6}` : ''}`
      : group.ticketTypeSummary;

  const partiallyCheckedIn = group.counts.checkedIn > 0 && group.counts.active > 0;

  return (
    <article
      aria-labelledby={`bg-${group.bookingId}`}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm transition-shadow hover:shadow-md"
    >
      {/* Artwork stands in for event/movie imagery */}
      <div
        className={`relative flex h-24 items-end bg-gradient-to-br p-4 ${gradientFor(group.bookingId)}`}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-background-surface/90 px-2.5 py-1 text-caption font-medium text-text-secondary shadow-sm backdrop-blur">
          {group.isMovie ? (
            <Clapperboard className="h-3.5 w-3.5" />
          ) : (
            <TicketIcon className="h-3.5 w-3.5" />
          )}
          {group.counts.total} {group.counts.total === 1 ? 'ticket' : 'tickets'}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h2
          id={`bg-${group.bookingId}`}
          className="line-clamp-1 text-title font-semibold text-text-primary"
        >
          {group.title}
        </h2>

        <div className="mt-2 space-y-1.5 text-[0.9375rem] text-text-secondary">
          <p className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" />
            {dateTime(group.startsAt)}
          </p>
          <p className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="line-clamp-1">{placeLine}</span>
          </p>
          <p className="flex items-center gap-1.5">
            {group.seatLabels.length > 0 ? (
              <Armchair className="h-4 w-4 shrink-0 text-text-muted" />
            ) : (
              <TicketIcon className="h-4 w-4 shrink-0 text-text-muted" />
            )}
            <span className="line-clamp-1">{detailLine}</span>
          </p>
        </div>

        {/* Group status summary + check-in progress (text + icon, never colour alone) */}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`inline-flex items-center gap-1.5 text-caption font-medium ${text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {group.summary}
          </span>
          {group.counts.checkedIn > 0 && (
            <span className="text-caption text-text-muted">· {group.checkInProgress}</span>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
          <span className="font-mono text-caption text-text-muted">Ref {group.bookingRef}</span>
          <div className="flex items-center gap-2">
            {partiallyCheckedIn && (
              <Link
                href={`${viewerHref}?active=1`}
                className="rounded-md px-2 py-1.5 text-caption font-medium text-action-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Next active QR
              </Link>
            )}
            <Link
              href={viewerHref}
              className="inline-flex items-center gap-1.5 rounded-md bg-action-primary px-4 py-2 text-caption font-semibold text-action-primary-foreground shadow-sm transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              {single ? 'View ticket' : 'View tickets'}
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
