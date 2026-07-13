'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  api,
  MetricCard,
  Card,
  DataTable,
  Skeleton,
  ErrorState,
  money,
  dateOnly,
  type Column,
} from '@eticketsgo/web-kit';

export default function ReportsTab() {
  const { id } = useParams<{ id: string }>();
  const {
    data: r,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.event(id),
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !r) return <Skeleton className="h-64 w-full" />;

  const byType: Column<(typeof r.salesByTicketType)[number]>[] = [
    { key: 't', header: 'Ticket type', render: (x) => x.ticketType },
    { key: 'q', header: 'Sold', render: (x) => x.quantity },
    { key: 'g', header: 'Gross', render: (x) => money(x.grossMinor) },
  ];
  const byDay: Column<(typeof r.salesByDay)[number]>[] = [
    { key: 'd', header: 'Day', render: (x) => dateOnly(x.day) },
    { key: 'b', header: 'Bookings', render: (x) => x.bookings },
    { key: 'g', header: 'Gross', render: (x) => money(x.grossMinor) },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Gross sales" value={money(r.grossTicketSalesMinor)} tone="success" />
        <MetricCard label="Net revenue" value={money(r.netOrganizerRevenueMinor)} tone="info" />
        <MetricCard label="Booking fees" value={money(r.bookingFeesMinor)} />
        <MetricCard
          label="Refunds"
          value={money(r.refundsMinor)}
          tone={r.refundsMinor > 0 ? 'warning' : 'neutral'}
        />
        <MetricCard label="Tickets sold" value={r.ticketsSold} />
        <MetricCard label="Tickets remaining" value={r.ticketsRemaining} />
        <MetricCard label="Checked in" value={r.checkInCount} />
        <MetricCard label="Payment fees" value={money(r.paymentFeesMinor)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Sales by ticket type">
          <DataTable
            columns={byType}
            rows={r.salesByTicketType}
            rowKey={(x) => x.ticketType}
            empty={<p className="p-4 text-sm text-text-muted">No sales yet.</p>}
          />
        </Card>
        <Card title="Sales by day">
          <DataTable
            columns={byDay}
            rows={r.salesByDay}
            rowKey={(x) => String(x.day)}
            empty={<p className="p-4 text-sm text-text-muted">No sales yet.</p>}
          />
        </Card>
      </div>
    </div>
  );
}
