'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Lightbulb, AlertTriangle, Sparkles, TrendingUp } from 'lucide-react';
import {
  api,
  MetricCard,
  Card,
  DataTable,
  Button,
  Skeleton,
  ErrorState,
  money,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
} from '@eticketsgo/web-kit';
import { deriveEventInsights, type InsightLevel } from '@eticketsgo/shared-types';

const LEVEL_ICON: Record<InsightLevel, typeof Lightbulb> = {
  warning: AlertTriangle,
  positive: Sparkles,
  info: TrendingUp,
};
const LEVEL_STYLE: Record<InsightLevel, string> = {
  warning: 'border-status-warning/30 bg-status-warning/5 text-status-warning',
  positive: 'border-status-success/30 bg-status-success/5 text-status-success',
  info: 'border-action-primary/30 bg-action-primary/5 text-action-primary',
};

export default function ReportsTab() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const {
    data: r,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.event(id),
  });
  const eventQ = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !r) return <Skeleton className="h-64 w-full" />;

  // Days until the next upcoming session (null when none / already past).
  const now = Date.now();
  const future = (eventQ.data?.sessions ?? [])
    .map((s) => new Date(s.startsAt).getTime())
    .filter((t) => t >= now)
    .sort((a, b) => a - b);
  const daysToEvent = future.length ? Math.round((future[0] - now) / 86_400_000) : null;

  const insights = deriveEventInsights({
    ticketsSold: r.ticketsSold,
    ticketsRemaining: r.ticketsRemaining,
    grossMinor: r.grossTicketSalesMinor,
    refundsMinor: r.refundsMinor,
    salesByTicketType: r.salesByTicketType,
    salesByDay: r.salesByDay.map((s) => ({
      day: new Date(s.day).toISOString().slice(0, 10),
      bookings: s.bookings,
      grossMinor: s.grossMinor,
    })),
    daysToEvent,
  });

  const exportCsv = async () => {
    setExporting(true);
    try {
      await api.reports.downloadEventCsv(id);
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    } finally {
      setExporting(false);
    }
  };

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
      <div className="flex items-center justify-between">
        <h2 className="text-title font-semibold text-text-primary">Report</h2>
        <Button variant="outline" size="sm" loading={exporting} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      {insights.length > 0 && (
        <Card title="Insights">
          <ul className="space-y-2.5">
            {insights.map((ins) => {
              const Icon = LEVEL_ICON[ins.level];
              return (
                <li
                  key={ins.key}
                  className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${LEVEL_STYLE[ins.level]}`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="text-[0.9375rem] font-semibold text-text-primary">{ins.title}</p>
                    <p className="mt-0.5 text-caption text-text-secondary">{ins.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

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
