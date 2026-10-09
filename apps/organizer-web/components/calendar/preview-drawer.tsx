'use client';

import { useEffect, useRef } from 'react';
import { ButtonLink, Drawer, StatusBadge } from '@eticketsgo/web-kit';
import {
  displayStatus,
  formatClock,
  localPlace,
  formatDayLong,
  statusText,
  zoneAbbrev,
  type CalendarSession,
} from '@/lib/calendar';
import { zoneLabel } from '@/lib/zoned-time';

/**
 * A quick look at one session without leaving the calendar: what, where, when (at the venue,
 * with its zone), its status in words, and tickets sold where the API reports them. Managing
 * it happens on the event's own page, one link away.
 */
export function PreviewDrawer({
  session,
  onClose,
}: {
  session: CalendarSession | null;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLParagraphElement>(null);

  // Move focus into the drawer when it opens, so a keyboard user is where the content is.
  useEffect(() => {
    if (!session) return;
    const t = window.setTimeout(() => headingRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [session]);

  const s = session;
  return (
    <Drawer open={s !== null} onClose={onClose} title={s?.title ?? 'Session'}>
      {s && <Body session={s} headingRef={headingRef} />}
    </Drawer>
  );
}

function Body({
  session: s,
  headingRef,
}: {
  session: CalendarSession;
  headingRef: React.RefObject<HTMLParagraphElement>;
}) {
  const start = localPlace(s.startsAt, s.zone);
  const end = localPlace(s.endsAt, s.zone);
  const abbrev = zoneAbbrev(s.zone, s.startsAt);
  const sameDay = start.day === end.day;
  // A session stored with no length (end not after start) has a start time and nothing more.
  const noLength = new Date(s.endsAt).getTime() <= new Date(s.startsAt).getTime();
  const when = noLength
    ? `${formatDayLong(start.day)}, ${formatClock(s.startsAt, s.zone)} ${abbrev}`
    : sameDay
      ? `${formatDayLong(start.day)}, ${formatClock(s.startsAt, s.zone)} - ${formatClock(s.endsAt, s.zone)} ${abbrev}`
      : `${formatDayLong(start.day)} ${formatClock(s.startsAt, s.zone)} to ${formatDayLong(end.day)} ${formatClock(s.endsAt, s.zone)} ${abbrev}`;
  const shown = displayStatus(s);

  return (
    <div className="space-y-5" data-testid="calendar-preview">
      <p
        ref={headingRef}
        tabIndex={-1}
        className="text-caption uppercase tracking-wide text-text-muted focus:outline-none"
      >
        {s.category}
      </p>

      <div className="flex flex-wrap gap-2">
        <StatusBadge status={s.eventStatus} label={`Event: ${statusText(s.eventStatus)}`} />
        {shown.status !== s.eventStatus && (
          <StatusBadge status={shown.status} label={shown.label} />
        )}
      </div>

      <dl className="space-y-3 text-[0.9375rem]">
        <div>
          <dt className="text-caption font-medium text-text-secondary">When (venue time)</dt>
          <dd className="text-text-primary">{when}</dd>
          <dd className="text-caption text-text-muted">
            {s.zoneKnown
              ? zoneLabel(s.zone, new Date(s.startsAt))
              : `This venue has no time zone set, so this is your browser's zone: ${zoneLabel(
                  s.zone,
                  new Date(s.startsAt),
                )}. Set the venue's time zone to be sure.`}
          </dd>
        </div>
        <div>
          <dt className="text-caption font-medium text-text-secondary">Where</dt>
          <dd className="text-text-primary">
            {[s.venueName, s.city].filter(Boolean).join(', ') || 'No venue'}
          </dd>
        </div>
        {s.capacity !== null && (
          <div>
            <dt className="text-caption font-medium text-text-secondary">Tickets</dt>
            <dd className="text-text-primary">
              {s.sold} sold of {s.capacity}
            </dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/organizer/events/${s.eventId}`}>Open event</ButtonLink>
        <ButtonLink href={`/organizer/events/${s.eventId}/sessions`} variant="outline">
          Sessions
        </ButtonLink>
      </div>
    </div>
  );
}
