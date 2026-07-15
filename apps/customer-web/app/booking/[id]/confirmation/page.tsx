'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { BellPlus, CalendarPlus, Check, Share2 } from 'lucide-react';
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
  });
  const upcoming = useQuery({
    queryKey: ['events', 'upcoming'],
    queryFn: () => api.listEvents({ pageSize: '3' }),
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
        <div className="flex justify-between border-t border-border pt-3 text-[0.9375rem]">
          <span className="text-text-secondary">Total paid</span>
          <span className="font-semibold text-text-primary">{money(booking.totalMinor)}</span>
        </div>
      </Card>

      {confirmed && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/account/tickets" className="flex-1">
              View my ticket
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
