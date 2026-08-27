'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { AssignAttendeeDialog } from '@/components/assign-attendee-dialog';
import { ShareDialog } from '@/components/share-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Car,
  ChevronLeft,
  ChevronRight,
  Download,
  LifeBuoy,
  MapPin,
  Maximize2,
  Navigation,
  ScanLine,
  Share2,
  UserPlus,
  Wallet,
  WifiOff,
} from 'lucide-react';
import {
  eventTiming,
  googleDirectionsUrl,
  googleMapsUrl,
  groupWalletTickets,
  isTicketInactive,
  nextActiveIndex,
  pickInitialTicketIndex,
  useConnectivity,
  useToast,
  type BookingGroup,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import { tokenStore } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { EmptyState, ErrorState, Skeleton, StatusBadge, ButtonLink } from '@/components/ui';
import { EventDayMode } from '@/components/event-day-mode';
import { fetchWalletWithOffline, lastSyncedAt } from '@/lib/offline/sync';
import { Link } from '@/i18n/navigation';

const QR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#f1f5f9"/><text x="110" y="112" font-family="sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">QR unavailable</text><text x="110" y="134" font-family="sans-serif" font-size="10" fill="#94a3b8" text-anchor="middle">Use the ticket ID at the gate</text></svg>',
  );

const SWIPE_THRESHOLD = 48;
const AUTO_ADVANCE_KEY = 'etg_auto_advance';

export default function BookingTicketsViewer() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();
  // Offline indicator derives from the browser hint AND real API-origin reachability (see web-kit's
  // connectivity model), so it stays correct after an offline reload where navigator.onLine is stale.
  const connectivity = useConnectivity();
  const online = connectivity.state === 'ONLINE' || connectivity.state === 'UNKNOWN';

  useEffect(() => {
    if (!tokenStore.access) router.push(`/login?next=/account/bookings/${bookingId}/tickets`);
  }, [router, bookingId]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['wallet'],
    queryFn: fetchWalletWithOffline,
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
  });
  // Last successful sync time — shown in Event Day Mode as "last verified".
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  useEffect(() => {
    lastSyncedAt().then(setSyncedAt);
  }, [data]);

  const group = useMemo(
    () => (data ? groupWalletTickets(data).find((g) => g.bookingId === bookingId) : undefined),
    [data, bookingId],
  );
  const tickets = useMemo(() => group?.tickets ?? [], [group]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventDayOpen, setEventDayOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    try {
      setAutoAdvance(window.localStorage.getItem(AUTO_ADVANCE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);
  const toggleAutoAdvance = () => {
    setAutoAdvance((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(AUTO_ADVANCE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Initialise selection: honour ?active=1, else first active / not-checked-in.
  useEffect(() => {
    if (tickets.length === 0) return;
    if (selectedId && tickets.some((t) => t.id === selectedId)) return;
    const wantActive =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('active') === '1';
    const activeIdx = tickets.findIndex((t) => t.status === 'ACTIVE');
    const idx = wantActive && activeIdx >= 0 ? activeIdx : pickInitialTicketIndex(tickets);
    setSelectedId(tickets[Math.max(0, idx)].id);
  }, [tickets, selectedId]);

  const index = Math.max(
    0,
    tickets.findIndex((t) => t.id === selectedId),
  );
  const current: WalletTicket | undefined = tickets[index];

  const goTo = useCallback(
    (next: number) => {
      if (tickets.length === 0) return;
      const clamped = Math.min(Math.max(next, 0), tickets.length - 1);
      setSelectedId(tickets[clamped].id);
    },
    [tickets],
  );

  // Auto-advance: when the selected ticket flips ACTIVE → CHECKED_IN on a data
  // refresh (organizer scanned it) and the option is on, move to the next active
  // ticket. Only fires on a real transition, so it never surprises the user.
  const prevStatuses = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevStatuses.current;
    if (autoAdvance && selectedId) {
      const sel = tickets.find((t) => t.id === selectedId);
      if (sel && prev.get(selectedId) === 'ACTIVE' && sel.status === 'CHECKED_IN') {
        const ni = nextActiveIndex(tickets, tickets.indexOf(sel));
        if (ni >= 0) setSelectedId(tickets[ni].id);
      }
    }
    prevStatuses.current = new Map(tickets.map((t) => [t.id, t.status]));
  }, [tickets, autoAdvance, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (eventDayOpen) return; // Event Day Mode owns keys while open
      if (e.key === 'ArrowRight') goTo(index + 1);
      else if (e.key === 'ArrowLeft') goTo(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, index, eventDayOpen]);

  useEffect(() => {
    if (current) headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!group]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      goTo(dx < 0 ? index + 1 : index - 1);
    }
  };

  const jumpNextActive = useCallback(() => {
    const ni = nextActiveIndex(tickets, index);
    if (ni >= 0) setSelectedId(tickets[ni].id);
  }, [tickets, index]);

  const backLink = (
    <button
      onClick={() => router.push('/account/tickets')}
      className="flex items-center gap-1.5 rounded-md text-[0.9375rem] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <ArrowLeft className="h-4 w-4" /> All tickets
    </button>
  );

  if (isError && !data)
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        {backLink}
        <ErrorState
          message="We couldn't load these tickets. Please try again."
          onRetry={() => refetch()}
        />
      </div>
    );

  if (isLoading && !data)
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        {backLink}
        <Skeleton className="h-[28rem] w-full" />
      </div>
    );

  if (!group || !current)
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        {backLink}
        <EmptyState
          title="Booking not found"
          hint="These tickets may have been refunded or belong to another account."
          action={<ButtonLink href="/account/tickets">Back to my tickets</ButtonLink>}
        />
      </div>
    );

  const timing = eventTiming(current.startsAt, Date.now());
  const canAssign = current.ownedByViewer !== false && current.status === 'ACTIVE';
  const assignmentLine = attendeeLine(current);
  const showNextActive = tickets.some((t) => t.status === 'ACTIVE') && current.status !== 'ACTIVE';
  const inactive = isTicketInactive(current.status);
  const seat = current.seatLabel;
  const place = group.isMovie
    ? [group.cinemaName, group.screenName, seat ? `Seat ${seat}` : null].filter(Boolean).join(' · ')
    : [group.venueName, seat ? `Seat ${seat}` : null].filter(Boolean).join(' · ');
  const mapsQuery = group.isMovie
    ? [group.cinemaName, group.venueName].filter(Boolean).join(', ') || group.title
    : group.venueName || group.title;

  return (
    <>
      <section className="mx-auto max-w-2xl space-y-6" aria-label={`Tickets for ${group.title}`}>
        <div className="flex items-center justify-between gap-3">
          {backLink}
          {!online && (
            <span className="inline-flex items-center gap-1.5 text-caption font-medium text-status-warning">
              <WifiOff className="h-3.5 w-3.5" /> Offline · saved tickets
            </span>
          )}
        </div>

        {/* Group header */}
        <GroupHeader group={group} />

        {/* Event Day Mode entry — prominent on event day, always available below */}
        {timing.isEventDay && (
          <button
            onClick={() => setEventDayOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-action-primary px-5 py-3.5 font-semibold text-action-primary-foreground shadow-sm transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
          >
            <Maximize2 className="h-4 w-4" /> Enter Event Day Mode
          </button>
        )}

        {/* Ticket viewer: one ticket at a time */}
        <div
          className="rounded-lg border border-border bg-background-surface shadow-sm"
          style={{ touchAction: 'pan-y' }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <div
            role="group"
            aria-label={`Ticket ${index + 1} of ${tickets.length}`}
            aria-live="polite"
            className="flex flex-col items-center p-6 text-center"
          >
            <p className="text-caption font-medium uppercase tracking-wide text-text-muted">
              Ticket {index + 1} of {tickets.length}
            </p>

            <div className="mt-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={current.id}
                src={current.qrDataUrl}
                alt={`QR code for ticket ${current.serial}`}
                onError={(e) => {
                  const img = e.currentTarget;
                  if (img.src !== QR_FALLBACK) img.src = QR_FALLBACK;
                }}
                className={`h-56 w-56 rounded-2xl bg-white p-2 shadow-sm ${inactive ? 'opacity-40 grayscale' : ''}`}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <StatusBadge status={current.status} />
              <span className="font-mono text-caption text-text-muted">{current.serial}</span>
            </div>

            <dl className="mt-3 space-y-0.5 text-[0.9375rem] text-text-secondary">
              <div className="flex items-center justify-center gap-1.5">
                <dt className="sr-only">Ticket type</dt>
                <dd>{current.ticketType}</dd>
              </div>
              {current.holderName && (
                <div>
                  <dt className="sr-only">Attendee</dt>
                  <dd>{current.holderName}</dd>
                </div>
              )}
              {place && (
                <div className="flex items-center justify-center gap-1.5 text-text-muted">
                  <MapPin className="h-3.5 w-3.5" aria-hidden />
                  <dt className="sr-only">Location</dt>
                  <dd>{place}</dd>
                </div>
              )}
              <div className="text-caption text-text-muted">
                <dt className="sr-only">Date and time</dt>
                <dd>{dateTime(current.startsAt)}</dd>
              </div>
            </dl>

            {assignmentLine && (
              <p className="mt-2 text-caption font-medium text-text-secondary">{assignmentLine}</p>
            )}

            {inactive && (
              <p className="mt-3 max-w-xs text-caption text-text-muted">
                This ticket is {current.status.toLowerCase().replace('_', ' ')} and can’t be used at
                the gate. It stays here as part of your booking history.
              </p>
            )}

            <Link
              href={`/account/tickets/${current.id}`}
              className="mt-4 text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Full ticket details
            </Link>
          </div>

          {tickets.length > 1 && (
            <div className="flex items-center justify-between border-t border-border p-3">
              <button
                onClick={() => goTo(index - 1)}
                disabled={index === 0}
                aria-label="Previous ticket"
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-[0.9375rem] font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </button>
              {showNextActive && (
                <button
                  onClick={jumpNextActive}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-caption font-semibold text-action-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <ScanLine className="h-4 w-4" /> Next active QR
                </button>
              )}
              <button
                onClick={() => goTo(index + 1)}
                disabled={index === tickets.length - 1}
                aria-label="Next ticket"
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-[0.9375rem] font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <QuickAction icon={Share2} label="Share" onClick={() => setShareOpen(true)} />
          <QuickAction
            icon={UserPlus}
            label="Assign"
            onClick={() =>
              canAssign
                ? setAssignOpen(true)
                : toast.push(
                    current.status === 'ACTIVE'
                      ? 'Only the booking owner can assign this ticket.'
                      : 'This ticket can no longer be reassigned.',
                    'info',
                  )
            }
          />
          <QuickAction icon={Download} label="PDF" onClick={() => window.print()} />
          <QuickAction
            icon={Wallet}
            label="Wallet"
            onClick={() => toast.push('Wallet passes are coming soon.', 'info')}
          />
          <QuickAction icon={Navigation} label="Directions" href={googleDirectionsUrl(mapsQuery)} />
          <QuickAction
            icon={Car}
            label="Parking"
            href={googleMapsUrl(`parking near ${mapsQuery}`)}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setEventDayOpen(true)}
            className="inline-flex items-center gap-1.5 text-caption font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Maximize2 className="h-3.5 w-3.5" /> Event Day Mode
          </button>
          <Link
            href="/help"
            className="inline-flex items-center gap-1.5 text-caption font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <LifeBuoy className="h-3.5 w-3.5" /> Support
          </Link>
        </div>

        {/* Ticket strip + auto-advance */}
        {tickets.length > 1 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-caption font-medium uppercase tracking-wide text-text-muted">
                All tickets in this booking
              </p>
              <label className="flex cursor-pointer items-center gap-1.5 text-caption text-text-secondary">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={toggleAutoAdvance}
                  className="h-3.5 w-3.5 rounded border-border text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                Auto-advance
              </label>
            </div>
            <TicketStrip tickets={tickets} index={index} onSelect={goTo} isMovie={group.isMovie} />
          </div>
        )}
      </section>

      {eventDayOpen && (
        <EventDayMode
          group={group}
          tickets={tickets}
          index={index}
          onNavigate={goTo}
          onExit={() => setEventDayOpen(false)}
          online={online}
          syncedAt={syncedAt}
        />
      )}

      <AssignAttendeeDialog
        ticket={current}
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
      />

      <ShareDialog ticket={current} open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  );
}

/** Human line describing who a ticket is assigned to, from the viewer's angle. */
function attendeeLine(t: WalletTicket): string | null {
  const status = t.assignmentStatus;
  if (!status || status === 'UNASSIGNED')
    return t.ownedByViewer === false ? null : 'Not yet assigned';
  if (t.assignedToViewer && !t.ownedByViewer) return 'This ticket is yours';
  const who = t.attendeeName || 'an attendee';
  if (status === 'INVITED') return `Invitation sent to ${who}`;
  if (status === 'ACCEPTED') return `Claimed by ${who}`;
  if (status === 'ASSIGNED') return `Assigned to ${who}`;
  if (status === 'DECLINED') return 'Invitation declined — reassign when ready';
  return null;
}

/** Group header: title, count, reference, check-in progress dots + status summary. */
function GroupHeader({ group }: { group: BookingGroup }) {
  const { counts } = group;
  const segments: { label: string; n: number; tone: string }[] = [
    { label: 'Active', n: counts.active, tone: 'text-status-success' },
    { label: 'Checked in', n: counts.checkedIn, tone: 'text-status-info' },
    { label: 'Transferred', n: counts.transferred, tone: 'text-text-secondary' },
    { label: 'Refunded', n: counts.refunded, tone: 'text-status-error' },
    { label: 'Cancelled', n: counts.cancelled, tone: 'text-status-error' },
  ].filter((s) => s.n > 0);

  return (
    <header>
      <h1 className="text-h3 font-bold tracking-tight text-text-primary" tabIndex={-1}>
        {group.title}
      </h1>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.9375rem] text-text-muted">
        <span>
          {counts.total} {counts.total === 1 ? 'ticket' : 'tickets'}
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono">{group.bookingRef}</span>
      </p>

      {/* Check-in progress: dots (never colour alone — filled ✓ vs hollow) */}
      {counts.total > 1 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-caption text-text-muted">
            <span>{group.checkInProgress}</span>
            <span>{counts.total - counts.checkedIn} remaining</span>
          </div>
          <div className="flex flex-wrap gap-1" role="img" aria-label={group.checkInProgress}>
            {group.tickets.map((t) => (
              <span
                key={t.id}
                className={`h-2.5 w-2.5 rounded-full ${
                  t.status === 'CHECKED_IN'
                    ? 'bg-status-info'
                    : t.status === 'ACTIVE'
                      ? 'bg-status-success'
                      : 'border border-border-strong bg-transparent'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Status summary — text + count, icon-independent (never hide any bucket) */}
      {segments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {segments.map((s) => (
            <li
              key={s.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-caption font-medium"
            >
              <span className={s.tone}>{s.n}</span>
              <span className="text-text-secondary">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

/** Numbered ticket strip: seat/index chips with a check mark for checked-in. */
function TicketStrip({
  tickets,
  index,
  onSelect,
  isMovie,
}: {
  tickets: WalletTicket[];
  index: number;
  onSelect: (i: number) => void;
  isMovie: boolean;
}) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Select a ticket">
      {tickets.map((t, i) => {
        const selected = i === index;
        const dim = isTicketInactive(t.status);
        const checkedIn = t.status === 'CHECKED_IN';
        const label = t.seatLabel ?? `${i + 1}`;
        return (
          <li key={t.id}>
            <button
              onClick={() => onSelect(i)}
              aria-current={selected ? 'true' : undefined}
              aria-label={`Ticket ${i + 1}${t.seatLabel ? `, seat ${t.seatLabel}` : ''}${
                isMovie ? '' : `, ${t.ticketType}`
              }, ${t.status.toLowerCase().replace('_', ' ')}`}
              className={`flex min-w-[3rem] items-center justify-center gap-1 rounded-md border px-3 py-2 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                selected
                  ? 'border-action-primary bg-tint-primary text-action-primary'
                  : 'border-border text-text-secondary hover:bg-background-subtle'
              } ${dim ? 'opacity-50' : ''}`}
            >
              {checkedIn && <span aria-hidden>✓</span>}
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
  href,
}: {
  icon: typeof Share2;
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const cls =
    'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-surface px-2 py-3 text-caption font-medium text-text-secondary shadow-sm transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
  const inner = (
    <>
      <Icon className="h-4 w-4" />
      {label}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}
