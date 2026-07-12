'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import {
  api,
  money,
  MetricCard,
  Card,
  StatusBadge,
  ButtonLink,
  Skeleton,
  EmptyState,
  PageHeader,
  dateOnly,
  type EventReport,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

export default function OrganizerDashboard() {
  const { activeOrg } = useOrg();

  const eventsQ = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });
  const payoutsQ = useQuery({
    queryKey: ['payouts', activeOrg.id],
    queryFn: () => api.payouts.forOrg(activeOrg.id),
  });

  const events = eventsQ.data ?? [];
  const reportQs = useQueries({
    queries: events.map((e) => ({
      queryKey: ['report', e.id],
      queryFn: () => api.reports.event(e.id),
      enabled: events.length > 0,
    })),
  });

  const reports = reportQs.map((q) => q.data).filter(Boolean) as EventReport[];
  const loading = eventsQ.isLoading || reportQs.some((q) => q.isLoading);

  const sum = reports.reduce(
    (a, r) => ({
      gross: a.gross + r.grossTicketSalesMinor,
      net: a.net + r.netOrganizerRevenueMinor,
      fees: a.fees + r.bookingFeesMinor,
      refunds: a.refunds + r.refundsMinor,
      sold: a.sold + r.ticketsSold,
      checkins: a.checkins + r.checkInCount,
    }),
    { gross: 0, net: 0, fees: 0, refunds: 0, sold: 0, checkins: 0 },
  );
  const checkinRate = sum.sold > 0 ? Math.round((sum.checkins / sum.sold) * 100) : 0;
  const latestPayout = payoutsQ.data?.[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${activeOrg.name}`}
        description="Your sales, tickets, and payout status at a glance."
        action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard label="Gross sales" value={money(sum.gross)} tone="success" />
          <MetricCard label="Net revenue" value={money(sum.net)} tone="info" />
          <MetricCard label="Booking fees" value={money(sum.fees)} />
          <MetricCard
            label="Refunds"
            value={money(sum.refunds)}
            tone={sum.refunds > 0 ? 'warning' : 'neutral'}
          />
          <MetricCard label="Tickets sold" value={sum.sold} />
          <MetricCard
            label="Check-in rate"
            value={`${checkinRate}%`}
            hint={`${sum.checkins} of ${sum.sold} checked in`}
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Your events" className="lg:col-span-2">
          {eventsQ.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : events.length === 0 ? (
            <EmptyState
              title="No events yet"
              hint="Create your first event to start selling tickets."
              action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
            />
          ) : (
            <ul className="divide-y divide-border">
              {events.slice(0, 6).map((e) => (
                <li key={e.id} className="flex items-center justify-between py-2">
                  <div>
                    <a
                      href={`/organizer/events/${e.id}`}
                      className="font-medium text-text-primary hover:text-action-primary"
                    >
                      {e.title}
                    </a>
                    <p className="text-xs text-text-muted">
                      {e.venue.city} · {e._count.sessions} session(s) · {e._count.bookings}{' '}
                      booking(s)
                    </p>
                  </div>
                  <StatusBadge status={e.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest payout">
          {payoutsQ.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : latestPayout ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Status</span>
                <StatusBadge status={latestPayout.status} />
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Net amount</span>
                <span className="font-semibold text-text-primary">
                  {money(latestPayout.netMinor)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Created</span>
                <span className="text-text-secondary">{dateOnly(latestPayout.createdAt)}</span>
              </div>
              <ButtonLink href="/organizer/payouts" variant="outline" className="mt-2 w-full">
                View payouts
              </ButtonLink>
            </div>
          ) : (
            <EmptyState
              title="No payouts yet"
              hint="Generate a settlement from the Payouts page."
            />
          )}
        </Card>
      </div>
    </div>
  );
}
