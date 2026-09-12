'use client';

import { useState } from 'react';
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
  MARKETS,
  type CurrencyMoney,
} from '@eticketsgo/web-kit';

/**
 * "United States · USD" rather than "USD".
 *
 * A currency code is how the data is grouped; a country is how an admin thinks about where the
 * platform sells. A currency with no known country keeps its code rather than guessing one.
 */
function marketLabel(market: CurrencyMoney): string {
  const name = MARKETS.find((m) => m.code === market.country)?.name;
  return name ? `${name} · ${market.currency}` : market.currency;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

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
  /*
    ── ONE MARKET AT A TIME ───────────────────────────────────────────────────────────
    The money cards summed rupees, dollars and Canadian dollars into one figure and printed it
    with a rupee sign. They now show one market, chosen here, the biggest market first.

    Every market is listed, including one that has sold nothing: reported from QA, the page
    showed India alone because the United States had bookings but none paid, and a market
    missing from the page cannot be told apart from one that does not exist. Bookings and
    payment failures follow the market too, so its "12 bookings, 0 paid" sits beside its
    money. Organizers, events, payouts and the analytics counts are not per currency and stay
    platform-wide.
  */
  const [currency, setCurrency] = useState<string | null>(null);

  const d = dash.data;
  const markets = d?.money ?? [];
  const market = markets.find((m) => m.currency === currency) ?? markets[0];

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

      {markets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Market">
          <span className="text-sm text-text-muted">Showing figures for</span>
          {markets.map((m) => (
            <button
              key={m.currency}
              type="button"
              onClick={() => setCurrency(m.currency)}
              aria-pressed={m.currency === market?.currency}
              className={`rounded-full border px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                m.currency === market?.currency
                  ? 'border-action-primary bg-tint-primary text-action-primary'
                  : 'border-border text-text-secondary hover:bg-background-subtle'
              }`}
            >
              {marketLabel(m)}
            </button>
          ))}
        </div>
      )}

      {dash.isLoading || !d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Gross merchandise value"
            // A market with nothing paid reads "$0.00", not "—": it is a real zero in a real
            // currency, and a dash would read as "not loaded".
            value={market ? money(market.gmvMinor, market.currency) : '—'}
            hint={
              market
                ? market.paidBookings > 0
                  ? `${plural(market.paidBookings, 'paid booking')} in ${market.currency}`
                  : `No paid bookings yet in ${market.currency}`
                : 'No paid bookings yet'
            }
            tone="success"
          />
          <MetricCard
            label="Platform revenue"
            value={market ? money(market.platformRevenueMinor, market.currency) : '—'}
            hint={market ? `Booking and payment fees, ${market.currency}` : undefined}
            tone="info"
          />
          <MetricCard
            label="Total bookings"
            value={market ? market.totalBookings : d.totalBookings}
            hint={
              market
                ? `${plural(market.totalBookings, 'booking')} in ${market.currency}, ${market.paidBookings} paid`
                : 'All currencies'
            }
          />
          <MetricCard
            label="Refund volume"
            value={market ? money(market.refundVolumeMinor, market.currency) : '—'}
            hint={market ? `Completed refunds, ${market.currency}` : undefined}
            tone={market && market.refundVolumeMinor > 0 ? 'warning' : 'neutral'}
          />
          <MetricCard label="Active organizers" value={d.activeOrganizers} />
          <MetricCard label="Published events" value={d.publishedEvents} />
          <MetricCard
            label="Payment failures"
            value={market ? market.paymentFailures : d.paymentFailures}
            hint={market ? `On ${market.currency} bookings` : undefined}
            tone={(market ? market.paymentFailures : d.paymentFailures) > 0 ? 'error' : 'neutral'}
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

      {/*
        Every market side by side. The cards answer "how is this market doing"; this answers
        "where is the platform selling at all", which is the question a single-market view
        hides. Each amount is formatted in its own row's currency — `money()` without one
        prints rupees — and rows are never totalled, because a sum across currencies is not an
        amount of anything.
      */}
      {markets.length > 0 && (
        <Card title="By market">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Money, bookings and payment failures for each market
              </caption>
              <thead>
                <tr className="border-b border-border text-caption uppercase tracking-wide text-text-muted">
                  <th scope="col" className="whitespace-nowrap py-2 pr-4 font-semibold">
                    Market
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-4 text-right font-semibold">
                    GMV
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-4 text-right font-semibold">
                    Platform revenue
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-4 text-right font-semibold">
                    Refunds
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-4 text-right font-semibold">
                    Paid bookings
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 pr-4 text-right font-semibold">
                    All bookings
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2 text-right font-semibold">
                    Payment failures
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {markets.map((m) => (
                  <tr key={m.currency}>
                    <th
                      scope="row"
                      className="whitespace-nowrap py-2 pr-4 font-medium text-text-primary"
                    >
                      {marketLabel(m)}
                    </th>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">
                      {money(m.gmvMinor, m.currency)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">
                      {money(m.platformRevenueMinor, m.currency)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">
                      {money(m.refundVolumeMinor, m.currency)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{m.paidBookings}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{m.totalBookings}</td>
                    <td className="py-2 text-right tabular-nums">{m.paymentFailures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
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
