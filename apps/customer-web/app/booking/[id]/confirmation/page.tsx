'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { BellPlus, CalendarPlus, Check, ReceiptText, Share2 } from 'lucide-react';
import { RatingStars, Stepper, buildIcsDataUrl, useToast } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { EventCard } from '@/components/event-card';
import { ButtonLink, Card, ErrorState, StatusBadge } from '@/components/ui';

const BOOKING_STEPS = ['Tickets', 'Payment', 'Confirmation', 'Ticket'];

export default function ConfirmationPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [following, setFollowing] = useState(false);

  const {
    data: booking,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
    // Confirmation arrives via an async signed webhook — poll until confirmed so the
    // buyer isn't stranded on a "pending" screen, then stop.
    refetchInterval: (query) => (query.state.data?.status === 'CONFIRMED' ? false : 4000),
  });
  const upcoming = useQuery({
    queryKey: ['events', 'upcoming'],
    queryFn: () => api.listEvents({ pageSize: '3' }),
  });
  // The document is issued in the same transaction that confirms the booking, so it exists
  // by the time the status flips — but only then. Gate the query on CONFIRMED rather than
  // polling for a document that cannot yet exist.
  /*
    The tickets themselves, on the confirmation screen.

    Requested from QA: "once booking confirmed, along with confirmation show the tickets, do
    not need to click on view tickets". The QR is the thing the buyer came for and the thing
    they need at the door — putting it one click away on a page they have already reached is
    a step that earns nothing.

    Gated on CONFIRMED because tickets are minted at confirmation; before that there is
    nothing to fetch. The wallet returns every ticket the account holds, so it is filtered to
    this booking rather than showing somebody their whole history on a confirmation page.
  */
  const ticketsQ = useQuery({
    queryKey: ['tickets', 'wallet'],
    queryFn: () => api.wallet(),
    enabled: booking?.status === 'CONFIRMED',
  });

  const receipts = useQuery({
    queryKey: ['booking', id, 'receipts'],
    queryFn: () => api.bookingReceipts(id),
    enabled: booking?.status === 'CONFIRMED',
  });

  if (isError)
    return (
      <ErrorState
        message="We couldn't load your booking. Please try again."
        onRetry={() => refetch()}
      />
    );
  if (isLoading || !booking)
    return <div className="h-64 animate-pulse rounded-lg bg-background-subtle" />;

  const confirmed = booking.status === 'CONFIRMED';
  // The sale document. A credit note may also be present after a refund; the confirmation
  // screen shows the sale.
  const receipt = receipts.data?.find((r) => r.kind !== 'CREDIT_NOTE');
  const tickets = (ticketsQ.data ?? []).filter((t) => t.bookingId === id);
  const ics = buildIcsDataUrl({
    title: booking.event.title,
    description: 'Your ETicketsGo booking',
    start: booking.eventSession.startsAt,
  });

  const share = async () => {
    const url = `${window.location.origin}/events/${booking.event.slug}`;
    if (navigator.share)
      await navigator.share({ title: booking.event.title, url }).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      toast.push('Event link copied.', 'success');
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Stepper steps={BOOKING_STEPS} current={confirmed ? 2 : 1} />

      <div className="text-center">
        <div
          className={`mx-auto flex h-16 w-16 animate-scale-in items-center justify-center rounded-full ${
            confirmed
              ? 'bg-status-success/15 text-status-success'
              : 'bg-status-warning/15 text-status-warning'
          }`}
          aria-hidden
        >
          {confirmed ? <Check className="h-8 w-8" strokeWidth={2.5} /> : '…'}
        </div>
        <h1 className="mt-4 text-h2 font-bold tracking-tight text-text-primary">
          {confirmed ? 'You’re going! 🎉' : 'Booking pending'}
        </h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-secondary">
          {confirmed
            ? `${booking.tickets.length} ticket(s) sent to ${booking.buyerEmail}.`
            : 'Your payment has not completed yet.'}
        </p>
      </div>

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-text-primary">{booking.event.title}</p>
          <StatusBadge status={booking.status} />
        </div>
        <p className="text-[0.9375rem] text-text-muted">
          {dateTime(booking.eventSession.startsAt)}
        </p>
        {booking.reference && (
          <div className="flex items-center justify-between text-[0.9375rem]">
            <span className="text-text-secondary">Booking reference</span>
            <span className="font-mono font-medium text-text-primary">{booking.reference}</span>
          </div>
        )}
        {/*
          Tax is shown line by line, matching the receipt exactly. A buyer comparing the two
          should never have to reconcile a different breakdown of the same amount.
        */}
        {(booking.taxLines ?? []).map((t) => (
          <div
            key={`${t.label}-${t.rateBasisPoints}`}
            className="flex justify-between text-[0.9375rem]"
          >
            <span className="text-text-secondary">
              {t.label} ({(t.rateBasisPoints / 100).toFixed(t.rateBasisPoints % 100 === 0 ? 0 : 2)}
              %)
            </span>
            <span className="text-text-primary">{money(t.amountMinor)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-border pt-3 text-[0.9375rem]">
          <span className="text-text-secondary">Total paid</span>
          <span className="font-semibold text-text-primary">{money(booking.totalMinor)}</span>
        </div>
        {receipt && (
          <button
            type="button"
            onClick={() => void api.openReceipt(receipt.id)}
            className="flex w-full items-center justify-between border-t border-border pt-3 text-left text-[0.9375rem] text-brand hover:underline"
          >
            <span className="inline-flex items-center gap-2">
              <ReceiptText className="h-4 w-4" />
              {receipt.kind === 'TAX_INVOICE' ? 'Tax invoice' : 'Receipt'} {receipt.number}
            </span>
            <span>View</span>
          </button>
        )}
      </Card>

      {confirmed && (
        <>
          {/*
            The QR, right here. It is what the buyer came for and what the door scans.
          */}
          {tickets.length > 0 ? (
            <div className="space-y-3">
              {tickets.map((t) => (
                <Card key={t.id} className="flex items-center gap-4">
                  <img
                    src={t.qrDataUrl}
                    alt={`Entry QR code for ticket ${t.serial}`}
                    className="h-28 w-28 shrink-0 rounded-md bg-white p-1"
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold text-text-primary">{booking.event.title}</p>
                    <p className="text-[0.9375rem] text-text-muted">
                      {dateTime(booking.eventSession.startsAt)}
                    </p>
                    {t.seatLabel ? (
                      <p className="text-[0.9375rem] text-text-primary">
                        Seat <strong>{t.seatLabel}</strong>
                        {t.screenName ? ` · ${t.screenName}` : ''}
                      </p>
                    ) : null}
                    <p className="font-mono text-caption text-text-muted">{t.serial}</p>
                  </div>
                </Card>
              ))}
              <p className="text-caption text-text-muted">
                Show this at the door. It is also saved in your tickets, and a copy is on its way to{' '}
                {booking.buyerEmail}.
              </p>
            </div>
          ) : ticketsQ.isLoading ? (
            <div className="h-32 animate-pulse rounded-lg bg-background-subtle" />
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/account/tickets" className="flex-1">
              All my tickets
            </ButtonLink>
            <a
              href={ics}
              download={`${booking.event.slug}.ics`}
              className="flex flex-1 items-center justify-center gap-2 rounded-md border border-border bg-background-surface px-4 py-2.5 text-[0.9375rem] font-medium text-text-primary shadow-sm transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              <CalendarPlus className="h-4 w-4" /> Add to calendar
            </a>
            <button
              onClick={share}
              className="flex items-center justify-center gap-2 rounded-md border border-border bg-background-surface px-4 py-2.5 text-[0.9375rem] font-medium text-text-primary shadow-sm transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              <Share2 className="h-4 w-4" /> Share
            </button>
          </div>

          {/* Rate + follow */}
          <Card className="space-y-4">
            <div>
              <p className="font-medium text-text-primary">How was booking?</p>
              <div className="mt-2">
                <RatingStars
                  value={rating}
                  onChange={(n) => {
                    setRating(n);
                    toast.push('Thanks for the feedback!', 'success');
                  }}
                  size="lg"
                  label="Rate your booking experience"
                />
              </div>
            </div>
            <button
              onClick={() => {
                setFollowing(true);
                toast.push('You’ll hear about new events from this organizer.', 'info');
              }}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-4 py-2.5 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              <BellPlus className="h-4 w-4" />
              {following ? 'Following organizer' : 'Follow organizer'}
            </button>
          </Card>
        </>
      )}

      {/* Recommendations */}
      {upcoming.data && upcoming.data.data.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-title font-semibold text-text-primary">You might also like</h2>
          <div className="grid gap-4">
            {upcoming.data.data.slice(0, 2).map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
