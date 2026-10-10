'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CalendarCheck2,
  Clapperboard,
  Coins,
  CreditCard,
  Landmark,
  Repeat,
  RotateCcw,
  Ticket,
  Wallet,
} from 'lucide-react';
import { NeedsYou } from '@/components/needs-you';
import { CinemaPricingSummary } from '@/components/overview/cinema-pricing-summary';
import { PlatformHealth } from '@/components/overview/platform-health';
import { QuickLinks } from '@/components/overview/quick-links';
import { RecentActivity } from '@/components/overview/recent-activity';
import { TodayShows } from '@/components/overview/today-shows';
import { WelcomeBand } from '@/components/overview/welcome-band';
import {
  api,
  ErrorState,
  MARKETS,
  SectionCard,
  SkeletonCard,
  StatCard,
  money,
  useAuthUser,
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

/** A figure still being fetched is a shape, never a zero: "0%" while loading is a false fact. */
function Pending() {
  // A span, not the Skeleton div: StatCard prints its value inside a <p>.
  return (
    <span className="inline-block h-7 w-20 animate-pulse rounded-md bg-background-subtle align-middle motion-reduce:animate-none">
      <span className="sr-only">Loading</span>
    </span>
  );
}

/**
 * The admin command center.
 *
 * ── WHAT IT IS ─────────────────────────────────────────────────────────────────────
 * The page an operator lands on at the start of a shift. It leads with the work (NeedsYou), then
 * what is on today, then how the marketplace is doing; a side column carries the ways in, the
 * platform's health, regulated cinema pricing and the last privileged actions. Every number on it
 * is read from an endpoint that already exists, and the page invents none: no trends, no
 * prior-period deltas, because no endpoint returns a prior period.
 *
 * ── EVERY PANEL IS SOMEBODY'S DUTY ─────────────────────────────────────────────────
 * Back-office authority is a set of named capabilities (least privilege, PR #291). Each panel
 * asks for its data only when the operator holds the capability its endpoint enforces, and is
 * not drawn otherwise - a moderator sees queues and today's shows, not money they cannot act
 * on, and the network tab shows no refusals. It is not the enforcement: every route keeps its
 * own guard.
 */
export default function AdminDashboard() {
  const { user } = useAuthUser();
  const caps = useMemo(() => new Set(user?.adminPermissions ?? []), [user?.adminPermissions]);
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
  const mayReadFigures = caps.has('BOOKING_READ');

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
  const a = analytics.data;

  return (
    <div className="space-y-6">
      <WelcomeBand />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-6">
          {/*
            The work first, the measurements after. Everything below this answers "how is the
            platform doing"; this answers "what should I do now", which is the question somebody
            opening the console at the start of a shift is actually asking.
          */}
          <NeedsYou />

          {caps.has('EVENT_REVIEW') && <TodayShows />}

          {!mayReadFigures && (
            <SectionCard title="Platform figures">
              <p className="text-sm text-text-secondary">
                Your duties do not include reading platform figures, so the money and booking
                numbers are not shown. Your queues are above.
              </p>
            </SectionCard>
          )}
        </div>

        <aside className="min-w-0 space-y-6" aria-label="At a glance">
          <QuickLinks capabilities={caps} />
          {caps.has('OPS_READ') && <PlatformHealth />}
          {caps.has('PLATFORM_CONFIG_READ') && <CinemaPricingSummary />}
          {mayReadFigures && <RecentActivity />}
        </aside>
      </div>

      {/*
        The line between the two halves of the page, said in words. Everything above asks for
        a decision; everything below is a measurement nobody has to act on, and a red number
        down here (payment failures, refunds) is a reading, not a queue - the queues are
        above.
      */}
      {mayReadFigures && (
        <SectionCard
          title="How the platform is doing"
          description="For information. Money is shown one currency at a time and is never added across currencies."
        >
          {/*
            An error is only an error for somebody who was allowed to ask, and it is this
            section's, not the page's: returning the whole page as "We couldn't load this"
            threw away the queues above, which a person can still act on.
          */}
          {dash.isError ? (
            <ErrorState
              message="We couldn't load the platform figures. Please try again."
              onRetry={() => dash.refetch()}
            />
          ) : (
            <>
              {markets.length > 0 && (
                <div
                  className="mb-4 flex flex-wrap items-center gap-2"
                  role="group"
                  aria-label="Market"
                >
                  <span className="text-caption text-text-muted">Showing figures for</span>
                  {markets.map((m) => (
                    <button
                      key={m.currency}
                      type="button"
                      onClick={() => setCurrency(m.currency)}
                      aria-pressed={m.currency === market?.currency}
                      className={`rounded-full border px-3 py-1 text-caption font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        m.currency === market?.currency
                          ? 'border-action-primary bg-tint-primary text-action-primary'
                          : 'border-border text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                      }`}
                    >
                      {marketLabel(m)}
                    </button>
                  ))}
                </div>
              )}

              {dash.isLoading || !d ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonCard key={i} variant="stat" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    icon={Wallet}
                    tile="blue"
                    label="Gross merchandise value"
                    // A market with nothing paid reads "$0.00", not "-": it is a real zero in a
                    // real currency, and a dash would read as "not loaded".
                    value={market ? money(market.gmvMinor, market.currency) : '-'}
                    hint={
                      market
                        ? market.paidBookings > 0
                          ? `${plural(market.paidBookings, 'paid booking')} in ${market.currency}`
                          : `No paid bookings yet in ${market.currency}`
                        : 'No paid bookings yet'
                    }
                  />
                  <StatCard
                    icon={Coins}
                    tile="teal"
                    label="Platform revenue"
                    value={market ? money(market.platformRevenueMinor, market.currency) : '-'}
                    hint={market ? `Booking and payment fees, ${market.currency}` : undefined}
                  />
                  <StatCard
                    icon={Ticket}
                    tile="purple"
                    label="Total bookings"
                    value={market ? market.totalBookings : d.totalBookings}
                    hint={
                      market
                        ? `${plural(market.totalBookings, 'booking')} in ${market.currency}, ${market.paidBookings} paid`
                        : 'All currencies'
                    }
                    href="/admin/bookings"
                  />
                  <StatCard
                    icon={RotateCcw}
                    tile="amber"
                    label="Refund volume"
                    value={market ? money(market.refundVolumeMinor, market.currency) : '-'}
                    hint={market ? `Completed refunds, ${market.currency}` : undefined}
                  />
                  <StatCard
                    icon={CreditCard}
                    tile="rose"
                    label="Payment failures"
                    value={market ? market.paymentFailures : d.paymentFailures}
                    hint={market ? `On ${market.currency} bookings` : undefined}
                    tone={
                      (market ? market.paymentFailures : d.paymentFailures) > 0
                        ? 'error'
                        : 'neutral'
                    }
                  />
                  <StatCard
                    icon={Building2}
                    tile="blue"
                    label="Active organizers"
                    value={d.activeOrganizers}
                    hint="Platform-wide"
                  />
                  <StatCard
                    icon={CalendarCheck2}
                    tile="teal"
                    label="Published events"
                    value={d.publishedEvents}
                    hint="Platform-wide"
                  />
                  <StatCard
                    icon={Landmark}
                    tile="amber"
                    label="Upcoming payouts"
                    value={d.upcomingPayouts}
                    hint="Platform-wide"
                  />
                  <StatCard
                    icon={Repeat}
                    tile="purple"
                    label="Repeat-customer rate"
                    value={a ? `${a.retention.rate}%` : <Pending />}
                    hint={
                      a
                        ? `${a.retention.repeatCustomers} of ${a.retention.totalCustomers} customers`
                        : undefined
                    }
                  />
                  <StatCard
                    icon={Clapperboard}
                    tile="rose"
                    label="Movies live"
                    value={a ? a.moviesCount : <Pending />}
                    hint={a ? `${a.funnel.checkedIn} check-ins` : undefined}
                  />
                </div>
              )}
            </>
          )}
        </SectionCard>
      )}

      {/*
        ── "PENDING APPROVALS" WAS REMOVED, NOT MOVED ─────────────────────────────────────
        It listed two counts, "Organizers awaiting review" and "Events under review", with a
        button to each unfiltered list. The action centre at the top of this page now carries
        both of those numbers, plus what happens if they are left, plus a link that lands on
        the filtered queue rather than the page containing it. Keeping both meant the same
        fact twice on one screen, which is two things to reconcile, not reassurance.
      */}

      {/*
        Every market side by side. The cards answer "how is this market doing"; this answers
        "where is the platform selling at all", which is the question a single-market view
        hides. Each amount is formatted in its own row's currency - `money()` without one
        prints rupees - and rows are never totalled, because a sum across currencies is not an
        amount of anything.
      */}
      {mayReadFigures && markets.length > 0 && (
        <SectionCard title="By market" flush>
          {/* Focusable, so a keyboard user can scroll it sideways on a phone (WCAG 2.1.1). */}
          <div
            className="overflow-x-auto px-5 pb-3"
            tabIndex={0}
            role="region"
            aria-label="Figures by market"
          >
            <table className="w-full text-left text-ui">
              <caption className="sr-only">
                Money, bookings and payment failures for each market
              </caption>
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-muted">
                  <th scope="col" className="whitespace-nowrap py-2.5 pr-4 font-semibold">
                    Market
                  </th>
                  <th
                    scope="col"
                    className="whitespace-nowrap py-2.5 pr-4 text-right font-semibold"
                  >
                    GMV
                  </th>
                  <th
                    scope="col"
                    className="whitespace-nowrap py-2.5 pr-4 text-right font-semibold"
                  >
                    Platform revenue
                  </th>
                  <th
                    scope="col"
                    className="whitespace-nowrap py-2.5 pr-4 text-right font-semibold"
                  >
                    Refunds
                  </th>
                  <th
                    scope="col"
                    className="whitespace-nowrap py-2.5 pr-4 text-right font-semibold"
                  >
                    Paid bookings
                  </th>
                  <th
                    scope="col"
                    className="whitespace-nowrap py-2.5 pr-4 text-right font-semibold"
                  >
                    All bookings
                  </th>
                  <th scope="col" className="whitespace-nowrap py-2.5 text-right font-semibold">
                    Payment failures
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {markets.map((m) => (
                  <tr key={m.currency}>
                    <th
                      scope="row"
                      className="whitespace-nowrap py-2.5 pr-4 font-semibold text-text-primary"
                    >
                      {marketLabel(m)}
                    </th>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-right tabular-nums">
                      {money(m.gmvMinor, m.currency)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-right tabular-nums">
                      {money(m.platformRevenueMinor, m.currency)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-right tabular-nums">
                      {money(m.refundVolumeMinor, m.currency)}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{m.paidBookings}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{m.totalBookings}</td>
                    <td className="py-2.5 text-right tabular-nums">{m.paymentFailures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
