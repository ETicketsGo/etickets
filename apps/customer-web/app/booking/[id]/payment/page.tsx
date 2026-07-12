'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { Button, Card } from '@/components/ui';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'text-base font-semibold' : 'text-sm'}`}>
      <span className={strong ? 'text-text-primary' : 'text-text-secondary'}>{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
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
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-text-primary">
          This booking is {booking.status.replaceAll('_', ' ').toLowerCase()}.
        </p>
        <Button className="mt-4" onClick={() => router.push(`/booking/${id}/confirmation`)}>
          View booking
        </Button>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Review & pay</h1>
      <Card className="space-y-3">
        <div>
          <p className="font-semibold text-text-primary">{booking.event.title}</p>
          <p className="text-sm text-text-muted">{dateTime(booking.eventSession.startsAt)}</p>
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
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}
      <Button className="w-full" disabled={pay.isPending} onClick={() => pay.mutate()}>
        {pay.isPending ? 'Processing payment…' : `Pay ${money(booking.totalMinor)} (mock)`}
      </Button>
      <p className="text-center text-xs text-text-muted">
        This is a mock payment. Confirmation happens via a signed webhook, not this button.
      </p>
    </div>
  );
}
