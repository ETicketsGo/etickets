'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NeedsYou } from '@/components/needs-you';
import {
  api,
  MetricCard,
  Card,
  Skeleton,
  ErrorState,
  EmptyState,
  money,
  dateTime,
  titleCase,
  PageHeader,
  MARKETS,
  useAuthUser,
  type CurrencyMoney,
} from '@eticketsgo/web-kit';
import { accountContactText } from '../../components/account-contact';

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
  /*
    ── THE FIGURES ARE NOT EVERY OPERATOR'S ───────────────────────────────────────────
    `GET /admin/dashboard`, `/admin/platform-analytics` and `/admin/audit` all require
    `BOOKING_READ`, and the moderation duty does not grant it. So somebody whose job is
    reviewing organizers and events signed in and the first thing they saw was "We couldn't
    load this. Please try again." - a dead end, on the landing page, with a retry button that
    could never work.

    Three requests were being made on behalf of an account that was never allowed to make
    them. Asking only when the capability is held fixes the screen and stops the refusals.
  */
  const { user } = useAuthUser();
  const mayReadFigures = (user?.adminPermissions ?? []).includes('BOOKING_READ');

  const dash = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: () => api.admin.dashboard(),
    enabled: mayReadFigures,
  });
  const analytics = useQuery({
    queryKey: ['admin', 'platform-analytics'],
    queryFn: () => api.admin.platformAnalytics(),
    enabled: mayReadFigures,
  });
  const audit = useQuery({
    queryKey: ['admin', 'audit', 1],
    queryFn: () => api.admin.audit({ page: 1, pageSize: 8 }),
    enabled: mayReadFigures,
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

  /*
    An error is only an error for somebody who was allowed to ask. Returning the whole page as
    "We couldn't load this" also threw away the action centre below it, which is the part a
    moderator came for and is perfectly able to see.
  */
  if (mayReadFigures && dash.isError)
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => dash.refetch()}
      />
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform overview"
        /* The page leads with work now, so "health at a glance" described only the half
           of it below the fold. */
        description="What needs you, and how the marketplace is doing."
      />

      {/*
        The work first, the measurements after. Everything below this answers "how is the
        platform doing"; this answers "what should I do now", which is the question somebody
        opening the console at the start of a shift is actually asking.
      */}
      <NeedsYou />

      {!mayReadFigures && (
        <Card title="Platform figures">
          <p className="text-sm text-text-secondary">
            Your duties do not include reading platform figures, so the money and booking numbers
            are not shown. Your queues are above.
          </p>
        </Card>
      )}

      {/*
        The line between the two halves of the page, said in words. Everything above asks for a
        decision; everything below is a measurement nobody has to act on, and a red number down
        here (payment failures, refunds) is a reading, not a queue - the queues are above.
      */}
      {mayReadFigures && (
        <div className="border-t border-border pt-6">
          <h2 className="text-title font-semibold text-text-primary">How the platform is doing</h2>
          <p className="mt-1 text-sm text-text-secondary">
            For information. Money is shown one currency at a time and is never added across
            currencies.
          </p>
        </div>
      )}

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

      {!mayReadFigures ? null : dash.isLoading || !d ? (
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
          {/* Focusable, so a keyboard user can scroll it sideways on a phone (WCAG 2.1.1). */}
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Figures by market"
          >
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

      {/*
        ── "PENDING APPROVALS" WAS REMOVED, NOT MOVED ─────────────────────────────────────
        It listed two counts, "Organizers awaiting review" and "Events under review", with a
        button to each unfiltered list. The action centre at the top of this page now carries
        both of those numbers, plus what happens if they are left, plus a link that lands on
        the filtered queue rather than the page containing it.

        Keeping both meant the same fact twice on one screen, which is not reassurance - it is
        two things to reconcile, and the moment one of them is counted differently the page
        contradicts itself. The weaker of the two went.
      */}
      <div className={mayReadFigures ? '' : 'hidden'}>
        <Card title="Recent activity">
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
                    {a.actor ? (accountContactText(a.actor.email) ?? 'an account') : 'system'} ·{' '}
                    {dateTime(a.createdAt)}
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
