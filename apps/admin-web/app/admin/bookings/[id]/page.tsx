'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  api,
  Card,
  Button,
  Skeleton,
  StatusBadge,
  PageHeader,
  money,
  dateTime,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';

export default function AdminBookingDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();

  const bookingQ = useQuery({ queryKey: ['booking', id], queryFn: () => api.bookings.get(id) });
  const refundsQ = useQuery({
    queryKey: ['booking', id, 'refunds'],
    queryFn: () => api.refunds.forBooking(id),
  });

  const process = useMutation({
    mutationFn: ({ refundId, decision }: { refundId: string; decision: 'APPROVE' | 'REJECT' }) =>
      api.refunds.process(refundId, decision),
    onSuccess: () => {
      toast.push('Refund processed.', 'success');
      qc.invalidateQueries({ queryKey: ['booking', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const b = bookingQ.data;
  if (bookingQ.isLoading || !b) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Booking"
        breadcrumbs={[{ label: 'Bookings', href: '/admin/bookings' }, { label: b.event.title }]}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Summary">
          <dl className="space-y-2 text-sm">
            <Row label="Booking ID" value={b.id} mono />
            <Row label="Event" value={b.event.title} />
            <Row label="Session" value={dateTime(b.eventSession.startsAt)} />
            <Row label="Buyer" value={`${b.buyerName} · ${b.buyerEmail}`} />
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <StatusBadge status={b.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Payment</dt>
              <dd>{b.payment ? <StatusBadge status={b.payment.status} /> : '—'}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Amounts">
          <dl className="space-y-2 text-sm">
            <Row label="Subtotal" value={money(b.subtotalMinor)} />
            {b.discountMinor > 0 && <Row label="Discount" value={`- ${money(b.discountMinor)}`} />}
            <Row label="Booking fee" value={money(b.bookingFeeMinor)} />
            <Row label="Payment fee" value={money(b.paymentFeeMinor)} />
            <Row label="Total" value={money(b.totalMinor)} />
          </dl>
        </Card>
      </div>

      <Card title={`Tickets (${b.tickets.length})`}>
        <ul className="divide-y divide-border text-sm">
          {b.tickets.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2">
              <span className="font-mono text-xs text-text-muted">{t.id}</span>
              <StatusBadge status={t.status} />
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Refunds">
        {refundsQ.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : refundsQ.data && refundsQ.data.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {refundsQ.data.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-text-primary">{money(r.amountMinor)}</p>
                  <p className="text-xs text-text-muted">{r.reason}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  {r.status === 'REQUESTED' && (
                    <>
                      <Button
                        loading={process.isPending}
                        onClick={() => process.mutate({ refundId: r.id, decision: 'APPROVE' })}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        loading={process.isPending}
                        onClick={() => process.mutate({ refundId: r.id, decision: 'REJECT' })}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No refunds for this booking.</p>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`text-right text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
