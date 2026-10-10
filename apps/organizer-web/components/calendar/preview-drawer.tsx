'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { CalendarClock, MapPin, Tag, type LucideIcon } from 'lucide-react';
import { ButtonLink, Drawer, IconTile, ProgressMeter, StatusPill } from '@eticketsgo/web-kit';
import {
  displayStatus,
  formatClock,
  localPlace,
  formatDayLong,
  statusText,
  statusTone,
  zoneAbbrev,
  type CalendarSession,
} from '@/lib/calendar';
import { zoneLabel } from '@/lib/zoned-time';

/**
 * A quick look at one session without leaving the calendar: what, where, when (at the venue,
 * with its zone), its status in words, and tickets sold where the API reports them. Managing
 * it happens on the event's own page, one link away - in the drawer's footer, so the way on is
 * always in view however long the body grows.
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
      {s && <Body session={s} headingRef={headingRef} />}
    </Drawer>
  );
}

/** One fact with its icon tile, as the reference's event card lays out date and venue. */
function Fact({ icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <IconTile icon={icon} tone="neutral" size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium text-text-secondary">{label}</p>
        {children}
      </div>
    </div>
  );
}

function Body({
  session: s,
  headingRef,
}: {
  session: CalendarSession;
  headingRef: RefObject<HTMLParagraphElement>;
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
      <div className="space-y-3">
        <p
          ref={headingRef}
          tabIndex={-1}
          className="text-micro font-semibold uppercase tracking-wide text-text-muted focus:outline-none"
        >
          {s.category}
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={statusTone(s.eventStatus)}>
            Event: {statusText(s.eventStatus)}
          </StatusPill>
          {shown.status !== s.eventStatus && (
            <StatusPill tone={statusTone(shown.status)}>{shown.label}</StatusPill>
          )}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-background-canvas p-4 text-ui">
        <Fact icon={CalendarClock} label="When (venue time)">
          <p className="font-medium text-text-primary">{when}</p>
          <p className="mt-0.5 text-caption text-text-muted">
            {s.zoneKnown
              ? zoneLabel(s.zone, new Date(s.startsAt))
              : `This venue has no time zone set, so this is your browser's zone: ${zoneLabel(
                  s.zone,
                  new Date(s.startsAt),
                )}. Set the venue's time zone to be sure.`}
          </p>
        </Fact>
        <Fact icon={MapPin} label="Where">
          <p className="font-medium text-text-primary">
            {[s.venueName, s.city].filter(Boolean).join(', ') || 'No venue'}
          </p>
        </Fact>
        {/* Only what the API reports: a capacity with no sold count is not shown as 0 sold. */}
        {s.capacity !== null && (
          <Fact icon={Tag} label="Tickets">
            {s.sold !== null ? (
              <div className="mt-1">
                <ProgressMeter value={s.sold} max={s.capacity} />
              </div>
            ) : (
              <p className="font-medium text-text-primary">{s.capacity} on sale</p>
            )}
          </Fact>
        )}
      </div>
    </div>
  );
}
