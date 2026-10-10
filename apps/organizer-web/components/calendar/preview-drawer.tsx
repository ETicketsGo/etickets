'use client';

import { useEffect, useRef } from 'react';
import { CalendarClock, MapPin, Tag } from 'lucide-react';
import {
  ButtonLink,
  CalendarFact,
  CalendarPreview,
  Drawer,
  ProgressMeter,
} from '@eticketsgo/web-kit';
import {
  displayStatus,
  formatClock,
  localPlace,
  formatDayLong,
  zoneAbbrev,
  type CalendarSession,
} from '@/lib/calendar';
import { zoneLabel } from '@/lib/zoned-time';

/**
 * A quick look at one session without leaving the calendar: what, where, when (at the venue,
 * with its zone), its status in words, and tickets sold where the API reports them. The layout
 * is the shared calendar's; the way on - the event and its sessions - is the organizer's, in the
 * drawer's footer, so it is always in view however long the body grows.
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
    <Drawer
      open={s !== null}
      onClose={onClose}
      title={s?.title ?? 'Session'}
      footer={
        s ? (
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/organizer/events/${s.eventId}`}>Open event</ButtonLink>
            <ButtonLink href={`/organizer/events/${s.eventId}/sessions`} variant="outline">
              Sessions
            </ButtonLink>
          </div>
        ) : undefined
      }
    >
      {s && (
        <CalendarPreview
          category={s.category}
          eventStatus={s.eventStatus}
          shown={displayStatus(s)}
          headingRef={headingRef}
        >
          <Facts session={s} />
        </CalendarPreview>
      )}
    </Drawer>
  );
}

function Facts({ session: s }: { session: CalendarSession }) {
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

  return (
    <>
      <CalendarFact icon={CalendarClock} label="When (venue time)">
        <p className="font-medium text-text-primary">{when}</p>
        <p className="mt-0.5 text-caption text-text-muted">
          {s.zoneKnown
            ? zoneLabel(s.zone, new Date(s.startsAt))
            : `This venue has no time zone set, so this is your browser's zone: ${zoneLabel(
                s.zone,
                new Date(s.startsAt),
              )}. Set the venue's time zone to be sure.`}
        </p>
      </CalendarFact>
      <CalendarFact icon={MapPin} label="Where">
        <p className="font-medium text-text-primary">
          {[s.venueName, s.city].filter(Boolean).join(', ') || 'No venue'}
        </p>
      </CalendarFact>
      {/* Only what the API reports: a capacity with no sold count is not shown as 0 sold. */}
      {s.capacity !== null && (
        <CalendarFact icon={Tag} label="Tickets">
          {s.sold !== null ? (
            <div className="mt-1">
              <ProgressMeter value={s.sold} max={s.capacity} />
            </div>
          ) : (
            <p className="font-medium text-text-primary">{s.capacity} on sale</p>
          )}
        </CalendarFact>
      )}
    </>
  );
}
