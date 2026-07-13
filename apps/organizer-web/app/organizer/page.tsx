'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  api,
  money,
  MetricCard,
  Card,
  StatusBadge,
  ButtonLink,
  Skeleton,
  EmptyState,
  ErrorState,
  PageHeader,
  dateOnly,
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
  // Single aggregate call for the whole organization — replaces the previous
  // per-event `useQueries` fan-out over `GET /reports/event/:id` (N+1).
  const analyticsQ = useQuery({
    queryKey: ['analytics', 'organizer', activeOrg.id],
    queryFn: () => api.analytics.organizer(activeOrg.id),
  });

  const events = eventsQ.data ?? [];
  const analytics = analyticsQ.data;
  const loading = eventsQ.isLoading || analyticsQ.isLoading;
  const isError = eventsQ.isError || payoutsQ.isError || analyticsQ.isError;
  const refetchAll = () => {
    eventsQ.refetch();
    payoutsQ.refetch();
    analyticsQ.refetch();
  };

  const revenue = analytics?.revenue;
  const sum = {
    gross: revenue?.grossMinor ?? 0,
    net: revenue?.netMinor ?? 0,
    fees: revenue?.bookingFeesMinor ?? 0,
    refunds: analytics?.refunds?.amountMinor ?? 0,
    sold: analytics?.attendance.issued ?? 0,
    checkins: analytics?.attendance.checkedIn ?? 0,
  };
  const checkinRate = analytics?.attendance.checkInRate ?? 0;
  const latestPayout = payoutsQ.data?.[0];

  const mostPopular = analytics?.topTicketType ?? null;
  const publishedCount = events.filter((e) => e.status === 'PUBLISHED').length;

  if (isError)
    return (
      <div className="space-y-6">
        <PageHeader
          title={`Welcome, ${activeOrg.name}`}
          description="Your sales, tickets, and payout status at a glance."
          action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
        />
        <ErrorState
          message="We couldn't load this. Please try again."
          onRetry={() => refetchAll()}
        />
      </div>
    );

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
          <MetricCard
            label="Most popular ticket"
            value={mostPopular?.name ?? '—'}
            hint={mostPopular ? `${mostPopular.quantity} sold` : 'No sales yet'}
          />
          <MetricCard
            label="Published events"
            value={publishedCount}
            hint={`${events.length} total`}
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
                    <Link
                      href={`/organizer/events/${e.id}`}
                      className="font-medium text-text-primary hover:text-action-primary"
                    >
                      {e.title}
                    </Link>
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

        <div className="space-y-6">
          <Card title="Quick actions">
            <div className="space-y-2">
              <ButtonLink href="/organizer/events/new" className="w-full">
                Create event
              </ButtonLink>
              <ButtonLink href="/organizer/events" variant="outline" className="w-full">
                Manage events
              </ButtonLink>
              <ButtonLink href="/organizer/payouts" variant="outline" className="w-full">
                View payouts
              </ButtonLink>
              <p className="pt-1 text-center text-caption text-text-muted">
                Export &amp; message attendees from an event’s Attendees tab.
              </p>
            </div>
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
    </div>
  );
}
