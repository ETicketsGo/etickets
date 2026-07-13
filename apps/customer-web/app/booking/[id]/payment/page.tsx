'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Clock, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { Button, ButtonLink, Card } from '@/components/ui';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between ${strong ? 'text-title font-semibold' : 'text-[0.9375rem]'}`}
    >
      <span className={strong ? 'text-text-primary' : 'text-text-secondary'}>{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}

/** Live mm:ss countdown to the hold expiry. */
function useCountdown(expiresAt: string | undefined) {
  const [remaining, setRemaining] = useState<number>(() =>
    expiresAt ? Math.max(0, new Date(expiresAt).getTime() - Date.now()) : 0,
  );
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemaining(Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  const totalSeconds = Math.floor(remaining / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return { expired: remaining <= 0, label: `${mm}:${ss}`, totalSeconds };
}

export default function PaymentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: booking, isLoading } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
  });

  const countdown = useCountdown(booking?.holdExpiresAt);

  const pay = useMutation({
    mutationFn: async () => {
      await api.createPaymentIntent(id);
      // A real gateway calls our signed webhook; the mock endpoint stands in.
      return api.mockPay(id, 'succeeded');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['booking', id] });
      router.push(`/booking/${id}/confirmation`);
    },
    onError: () => setError('Payment could not be completed. Please try again.'),
  });

  if (isLoading || !booking)
    return <div className="h-72 animate-pulse rounded-lg bg-background-subtle" />;

  if (booking.status !== 'PENDING_PAYMENT') {
    const refunded = booking.status.includes('REFUND');
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-text-primary">
          This booking is {booking.status.replaceAll('_', ' ').toLowerCase()}.
        </p>
        <Button className="mt-4" onClick={() => router.push(`/booking/${id}/confirmation`)}>
          {refunded ? 'View booking' : 'View booking'}
        </Button>
      </Card>
    );
  }

  const expired = countdown.expired;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-h2 font-bold tracking-tight text-text-primary">Review &amp; pay</h1>

      {/* Hold timer */}
      <div
        className={`flex items-center justify-between rounded-md border px-4 py-3 ${
          expired
            ? 'border-status-error/30 bg-status-error/5'
            : countdown.totalSeconds < 120
              ? 'border-status-warning/30 bg-status-warning/5'
              : 'border-border bg-background-subtle/60'
        }`}
      >
        <span className="flex items-center gap-2 text-[0.9375rem] text-text-secondary">
          <Clock className={`h-4 w-4 ${expired ? 'text-status-error' : 'text-text-muted'}`} />
          {expired ? 'Your ticket hold has expired.' : 'Tickets held for you'}
        </span>
        {!expired && (
          <span
            className={`font-mono text-title font-semibold tabular-nums ${
              countdown.totalSeconds < 120 ? 'text-status-warning' : 'text-text-primary'
            }`}
            aria-live="polite"
          >
            {countdown.label}
          </span>
        )}
      </div>

      <Card className="space-y-3">
        <div>
          <p className="font-semibold text-text-primary">{booking.event.title}</p>
          <p className="text-[0.9375rem] text-text-muted">
            {dateTime(booking.eventSession.startsAt)}
          </p>
        </div>
        <div className="space-y-1 border-t border-border pt-3">
          {booking.items.map((i, idx) => (
            <Row
              key={idx}
              label={`${i.quantity} × ${i.ticketType.name}`}
              value={money(i.unitPriceMinor * i.quantity)}
            />
          ))}
        </div>
        <div className="space-y-1 border-t border-border pt-3">
          <Row label="Subtotal" value={money(booking.subtotalMinor)} />
          {booking.discountMinor > 0 && (
            <Row label="Discount" value={`- ${money(booking.discountMinor)}`} />
          )}
          <Row label="Booking fee" value={money(booking.bookingFeeMinor)} />
          <Row label="Payment fee" value={money(booking.paymentFeeMinor)} />
        </div>
        <div className="border-t border-border pt-3">
          <Row label="Total payable" value={money(booking.totalMinor)} strong />
        </div>
      </Card>

      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}

      {expired ? (
        <div className="space-y-3 text-center">
          <p className="text-[0.9375rem] text-text-muted">
            The reserved tickets have been released. Please start a new booking.
          </p>
          <ButtonLink href={`/events/${booking.event.slug}`} className="w-full">
            Back to event
          </ButtonLink>
        </div>
      ) : (
        <>
          <Button className="w-full" loading={pay.isPending} onClick={() => pay.mutate()}>
            {pay.isPending ? 'Processing payment…' : `Pay ${money(booking.totalMinor)} (mock)`}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-caption text-text-muted">
            <ShieldCheck className="h-3.5 w-3.5" />
            Mock payment — confirmation happens via a signed webhook, not this button.
          </p>
        </>
      )}
    </div>
  );
}
