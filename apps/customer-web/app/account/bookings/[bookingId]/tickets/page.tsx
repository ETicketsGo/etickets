'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, MapPin, ScanLine } from 'lucide-react';
import {
  groupWalletTickets,
  isTicketInactive,
  pickInitialTicketIndex,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { EmptyState, ErrorState, Skeleton, StatusBadge, ButtonLink } from '@/components/ui';

const QR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#f1f5f9"/><text x="110" y="112" font-family="sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">QR unavailable</text><text x="110" y="134" font-family="sans-serif" font-size="10" fill="#94a3b8" text-anchor="middle">Use the ticket ID at the gate</text></svg>',
  );

const SWIPE_THRESHOLD = 48;

export default function BookingTicketsViewer() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();

  useEffect(() => {
    if (!tokenStore.access) router.push(`/login?next=/account/bookings/${bookingId}/tickets`);
  }, [router, bookingId]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
  });

  const group = useMemo(
    () => (data ? groupWalletTickets(data).find((g) => g.bookingId === bookingId) : undefined),
    [data, bookingId],
  );
  const tickets = useMemo(() => group?.tickets ?? [], [group]);

  // Track selection by ticket id so a background refetch (e.g. a ticket becomes
  // checked in) never yanks the user to a different card unexpectedly.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Initialise selection once tickets are available: honour ?active=1, else the
  // first active / not-checked-in / first ticket.
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

  // Keyboard: left/right arrows move between tickets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goTo(index + 1);
      else if (e.key === 'ArrowLeft') goTo(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, index]);

  // Move focus to the viewer heading when it first opens (accessibility).
  useEffect(() => {
    if (current) headingRef.current?.focus();
    // Focus once per booking open, not on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!group]);

  // Touch swipe (horizontal only; the container uses touch-action: pan-y so the
  // page still scrolls vertically but horizontal swipes drive navigation).
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

  const nextActive = useCallback(() => {
    if (tickets.length === 0) return;
    for (let step = 1; step <= tickets.length; step++) {
      const i = (index + step) % tickets.length;
      if (tickets[i].status === 'ACTIVE') {
        setSelectedId(tickets[i].id);
        return;
      }
    }
  }, [tickets, index]);

  const backLink = (
    <button
      onClick={() => router.push('/account/tickets')}
      className="flex items-center gap-1.5 rounded-md text-[0.9375rem] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <ArrowLeft className="h-4 w-4" /> All tickets
    </button>
  );

  if (isError)
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        {backLink}
        <ErrorState
          message="We couldn't load these tickets. Please try again."
          onRetry={() => refetch()}
        />
      </div>
    );

  if (isLoading || !data)
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

  const hasActive = tickets.some((t) => t.status === 'ACTIVE');
  const showNextActive = hasActive && current.status !== 'ACTIVE';
  const inactive = isTicketInactive(current.status);
  const seat = current.seatLabel;
  const place = group.isMovie
    ? [group.cinemaName, group.screenName, seat ? `Seat ${seat}` : null].filter(Boolean).join(' · ')
    : [group.venueName, seat ? `Seat ${seat}` : null].filter(Boolean).join(' · ');

  return (
    <section className="mx-auto max-w-2xl space-y-6" aria-label={`Tickets for ${group.title}`}>
      <div className="flex items-center justify-between gap-3">
        {backLink}
        <span className="font-mono text-caption text-text-muted">Ref {group.bookingRef}</span>
      </div>

      <div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-h3 font-bold tracking-tight text-text-primary focus:outline-none"
        >
          {group.title}
        </h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          {group.checkInProgress} · {group.counts.total}{' '}
          {group.counts.total === 1 ? 'ticket' : 'tickets'} in this booking
        </p>
      </div>

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

          {/* Large, stable QR — never animated or rotated */}
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

        {/* Prev / next */}
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
                onClick={nextActive}
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

      {/* Compact ticket index */}
      {tickets.length > 1 && (
        <div>
          <p className="mb-2 text-caption font-medium uppercase tracking-wide text-text-muted">
            All tickets in this booking
          </p>
          <ul className="flex flex-wrap gap-2" aria-label="Select a ticket">
            {tickets.map((t, i) => {
              const selected = i === index;
              const dim = isTicketInactive(t.status);
              const label = t.seatLabel ?? `#${i + 1}`;
              return (
                <li key={t.id}>
                  <button
                    onClick={() => goTo(i)}
                    aria-current={selected ? 'true' : undefined}
                    aria-label={`Ticket ${i + 1}${t.seatLabel ? `, seat ${t.seatLabel}` : ''}, ${t.status.toLowerCase().replace('_', ' ')}`}
                    className={`min-w-[3rem] rounded-md border px-3 py-2 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                      selected
                        ? 'border-action-primary bg-action-primary/10 text-action-primary'
                        : 'border-border text-text-secondary hover:bg-background-subtle'
                    } ${dim ? 'opacity-50' : ''}`}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
