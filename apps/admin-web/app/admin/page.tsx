'use client';

import { useQuery } from '@tanstack/react-query';
import {
  api,
  MetricCard,
  Card,
  Skeleton,
  ButtonLink,
  ErrorState,
  EmptyState,
  money,
  dateTime,
  titleCase,
  PageHeader,
} from '@eticketsgo/web-kit';

export default function AdminDashboard() {
  const dash = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: () => api.admin.dashboard() });
  const analytics = useQuery({
    queryKey: ['admin', 'platform-analytics'],
    queryFn: () => api.admin.platformAnalytics(),
  });
  const audit = useQuery({
    queryKey: ['admin', 'audit', 1],
    queryFn: () => api.admin.audit({ page: 1, pageSize: 8 }),
  });

  const d = dash.data;

  if (dash.isError)
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => dash.refetch()}
      />
    );

  return (
    <div className="space-y-6">
      <PageHeader title="Platform overview" description="Marketplace health at a glance." />

      {dash.isLoading || !d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Gross merchandise value" value={money(d.gmvMinor)} tone="success" />
          <MetricCard label="Platform revenue" value={money(d.platformRevenueMinor)} tone="info" />
          <MetricCard label="Total bookings" value={d.totalBookings} />
          <MetricCard
            label="Refund volume"
            value={money(d.refundVolumeMinor)}
            tone={d.refundVolumeMinor > 0 ? 'warning' : 'neutral'}
          />
          <MetricCard label="Active organizers" value={d.activeOrganizers} />
          <MetricCard label="Published events" value={d.publishedEvents} />
          <MetricCard
            label="Payment failures"
            value={d.paymentFailures}
            tone={d.paymentFailures > 0 ? 'error' : 'neutral'}
          />
          <MetricCard label="Upcoming payouts" value={d.upcomingPayouts} />
          <MetricCard
            label="Repeat-customer rate"
            value={`${analytics.data?.retention.rate ?? 0}%`}
            hint={
              analytics.data
                ? `${analytics.data.retention.repeatCustomers} of ${analytics.data.retention.totalCustomers}`
                : undefined
            }
            tone="info"
          />
          <MetricCard
            label="Movies live"
            value={analytics.data?.moviesCount ?? 0}
            hint={analytics.data ? `${analytics.data.funnel.checkedIn} check-ins` : undefined}
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Pending approvals" className="lg:col-span-1">
          {d && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Organizers awaiting review</span>
                <span className="font-semibold text-text-primary">{d.pendingOrganizers ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Events under review</span>
                <span className="font-semibold text-text-primary">{d.pendingEvents ?? 0}</span>
              </div>
              <div className="flex gap-2 pt-2">
                <ButtonLink href="/admin/organizers" variant="outline">
                  Review organizers
                </ButtonLink>
                <ButtonLink href="/admin/events" variant="outline">
                  Review events
                </ButtonLink>
              </div>
            </div>
          )}
        </Card>

        <Card title="Recent activity" className="lg:col-span-2">
          {audit.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : audit.isError ? (
            <ErrorState
              message="We couldn't load recent activity."
              onRetry={() => audit.refetch()}
            />
          ) : audit.data && audit.data.data.length > 0 ? (
            <ul className="divide-y divide-border text-sm">
              {audit.data.data.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <span className="text-text-primary">{titleCase(a.action)}</span>
                  <span className="text-text-muted">
                    {a.actor?.email ?? 'system'} · {dateTime(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No recent activity" hint="Privileged actions will appear here." />
          )}
        </Card>
      </div>
    </div>
  );
}
