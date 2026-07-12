'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { ButtonLink, Card, StatusBadge } from '@/components/ui';

export default function ConfirmationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: booking, isLoading } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
  });

  if (isLoading || !booking)
    return <div className="h-64 animate-pulse rounded-lg bg-background-subtle" />;

  const confirmed = booking.status === 'CONFIRMED';

  return (
    <div className="mx-auto max-w-lg space-y-6 text-center">
      <div
        className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl ${
          confirmed
            ? 'bg-status-success/15 text-status-success'
            : 'bg-status-warning/15 text-status-warning'
        }`}
        aria-hidden
      >
        {confirmed ? '✓' : '…'}
      </div>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">
          {confirmed ? 'Booking confirmed!' : 'Booking pending'}
        </h1>
        <p className="mt-1 text-text-secondary">
          {confirmed
            ? `${booking.tickets.length} ticket(s) issued to ${booking.buyerEmail}.`
            : 'Your payment has not completed yet.'}
        </p>
      </div>

      <Card className="space-y-2 text-left">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-text-primary">{booking.event.title}</p>
          <StatusBadge status={booking.status} />
        </div>
        <p className="text-sm text-text-muted">{dateTime(booking.eventSession.startsAt)}</p>
        <div className="border-t border-border pt-2 text-sm">
          <div className="flex justify-between">
            <span className="text-text-secondary">Total paid</span>
            <span className="font-semibold text-text-primary">{money(booking.totalMinor)}</span>
          </div>
        </div>
      </Card>

      <div className="flex justify-center gap-3">
        <ButtonLink href="/account/tickets">View my tickets</ButtonLink>
        <ButtonLink href="/events" variant="secondary">
          Browse more
        </ButtonLink>
      </div>
    </div>
  );
}
