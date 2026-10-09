'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Info,
  Megaphone,
  OctagonAlert,
  Percent,
  ScanLine,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  money,
  Badge,
  ButtonLink,
  EmptyState,
  ErrorState,
  Meter,
  PageHeader,
  SectionCard,
  SectionLink,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatusBadge,
  dateOnly,
  MARKETS,
  marketFor,
  useAuthUser,
  type AnalyticsOrganizerMarket,
  type NotificationFeedSeverity,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { WelcomeCard } from '@/components/onboarding-checklist';
import { isForbidden } from '@/lib/org-permissions';
import { relativeTime } from '@/lib/notification-feed-view';
import { formatClock, formatDayLong, localPlace, sessionZone, zoneAbbrev } from '@/lib/calendar';
import { NeedsAttention } from './needs-attention';
import {
  moneyFor,
  pendingActions,
  performanceFor,
  pickCurrency,
  recentActivity,
  comingUp,
  comingUpWindow,
  COMING_UP_DAYS,
  type MarketChoice,
  type MarketMoney,
} from './_dashboard/model';

/**
 * "India · INR" rather than "INR" - the same label the admin dashboard gives a market.
 *
 * A currency is how the money is grouped; a country is how an organizer thinks about where they
 * sell. A currency with no known country keeps its code rather than guessing one.
 */
function marketName(market: { country: string | null; currency: string }): string {
  const name = MARKETS.find((m) => m.code === market.country)?.name;
  return name ? `${name} · ${market.currency}` : market.currency;
}

const SEVERITY_ICON: Record<NotificationFeedSeverity, LucideIcon> = {
  CRITICAL: OctagonAlert,
  WARNING: AlertTriangle,
  SUCCESS: CheckCircle2,
  INFO: Info,
};
const SEVERITY_TEXT: Record<NotificationFeedSeverity, string> = {
  CRITICAL: 'text-status-error',
  WARNING: 'text-status-warning',
  SUCCESS: 'text-status-success',
  INFO: 'text-text-muted',
};

/** The notification centre's own react-query key, so this reads its cache, not a second copy. */
const FEED_KEY = ['notifications', 'feed', 'organizer'] as const;

const LINK_FOCUS =
  'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The organizer's Overview.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────────────
 * The pilot is a handful of organizers with a handful of events each. What they open this page
 * to learn is short: is anything wrong, what is on next, how much have I sold and how much of
 * it is mine. The page answers in that order - things that need them, then the money, then the
 * shows - and everything else is one link away rather than on the page.
 *
 * ── GROSS IS NOT NET ───────────────────────────────────────────────────────────────
 * The old cards put "Gross sales" in green and "Net revenue" in blue side by side, and an
 * organizer had to know what separated them. The difference is now drawn as the sum it is -
 * gross, less the fees taken from you, less refunds, equals what you keep - using the API's own
 * figures, so the arithmetic on screen is the arithmetic the API did.
 *
 * ── NOT SHOWN, BECAUSE THE API DOES NOT SAY ────────────────────────────────────────
 * A booking trend over time: the organizer analytics endpoint returns totals, not a series,
 * and the dated series that exist are admin-only reports. Drawing one from anything else would
 * be inventing it. Likewise an all-markets total: there is no exchange rate to make one.
 */
export default function OrganizerDashboard() {
  const { activeOrg, can } = useOrg();
  const { user } = useAuthUser();

  const eventsQ = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });
  /*
    Payouts are financial data and the API refuses them to check-in staff - but this is
    everybody's landing page, and a refused payouts read used to replace the whole dashboard
    with "We couldn't load this". So the read is skipped for a role that cannot make it, a
    refusal hides the card, and payouts never decide whether the rest of the page renders.
  */
  const payoutsQ = useQuery({
    queryKey: ['payouts', activeOrg.id],
    queryFn: () => api.payouts.forOrg(activeOrg.id),
    enabled: can.financials,
  });
  const showPayouts = can.financials && !isForbidden(payoutsQ.error);
  // Single aggregate call for the whole organization (no per-event fan-out).
  const analyticsQ = useQuery({
    queryKey: ['analytics', 'organizer', activeOrg.id],
    queryFn: () => api.analytics.organizer(activeOrg.id),
  });
  /*
    What is on next: the calendar's own endpoint, one request for every show of the
    organization in the coming week, with sold and capacity per show. The window is fixed at
    mount so the query key does not change on every render.
  */
  const [window7] = useState(() => comingUpWindow());
  const upcomingQ = useQuery({
    queryKey: ['organizer-calendar', activeOrg.id, window7.from, window7.to],
    queryFn: () => api.events.calendar(activeOrg.id, window7.from, window7.to),
  });
  const feedQ = useQuery({
    queryKey: FEED_KEY,
    queryFn: () => api.notifications.feed('ORGANIZER'),
  });

  const events = eventsQ.data ?? [];
  const analytics = analyticsQ.data;
  const loading = eventsQ.isLoading || analyticsQ.isLoading;
  const isError = eventsQ.isError || analyticsQ.isError;

  /*
    ── MONEY IS PER MARKET, AND THE ORGANIZER PICKS WHICH ONE ────────────────────────
    Every market the organization sells in or has a venue in, including one that has taken
    nothing yet. An older API without `markets` falls back to the currencies with revenue.
    The switch appears only when there is genuinely more than one.
  */
  const revenues = analytics?.revenue ?? [];
  const countries = analytics?.countries ?? [];
  const markets: AnalyticsOrganizerMarket[] = analytics?.markets ?? [];
  const choices: MarketChoice[] =
    markets.length > 0
      ? markets.map((m) => ({ currency: m.currency, label: marketName(m) }))
      : revenues.map((r) => ({
          currency: r.currency,
          label: `${countries.find((c) => c.currency === r.currency)?.country ?? r.currency} · ${r.currency}`,
        }));
  const [market, setMarket] = useState<string | null>(null);
  const homeCurrency = marketFor(activeOrg.registeredCountry ?? '')?.currency ?? null;
  const activeCurrency = pickCurrency(choices, homeCurrency, market);
  const activeLabel = choices.find((c) => c.currency === activeCurrency)?.label;
  const cash = activeCurrency ? moneyFor(analytics, activeCurrency) : null;
  const fmt = (minor: number) => money(minor, activeCurrency ?? undefined);

  const capacity = analytics?.capacity;
  const conversion = analytics?.conversion;
  const attendance = analytics?.attendance;
  const repeat = analytics?.repeatVisitors;
  const performance = performanceFor(analytics, activeCurrency);
  const upcoming = comingUp(upcomingQ.data?.sessions);
  const pending = pendingActions(feedQ.data).slice(0, 4);
  const activity = recentActivity(feedQ.data, 5);
  const latestPayout = payoutsQ.data?.[0];
  const publishedCount = events.filter((e) => e.status === 'PUBLISHED').length;
  const firstName = user?.fullName?.trim().split(/\s+/)[0];

  const header = (
    <PageHeader
      eyebrow="Overview"
      title={activeOrg.name}
      description={`Welcome back${firstName ? `, ${firstName}` : ''}. What needs you, what is on next, and how sales are going.`}
      meta={
        <>
          <StatusBadge status={activeOrg.status} />
          {activeOrg.verified && <Badge tone="success">Verified</Badge>}
        </>
      }
      action={
        <>
          <ButtonLink href="/organizer/events" variant="outline">
            All events
          </ButtonLink>
          <ButtonLink href="/organizer/events/new">Create event</ButtonLink>
        </>
      }
    />
  );

  if (isError)
    return (
      <div>
        {header}
        <ErrorState
          message="We could not load your overview. Please try again."
          onRetry={() => {
            eventsQ.refetch();
            analyticsQ.refetch();
          }}
        />
      </div>
    );

  return (
    <div>
      {header}

      <div className="space-y-6">
        <WelcomeCard orgId={activeOrg.id} />

        {/*
          What the platform still needs from them, before the numbers. An organizer whose
          settlements cannot be paid should read that first, not after scrolling past a chart.
          It renders nothing when there is nothing outstanding.
        */}
        <NeedsAttention orgId={activeOrg.id} />

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="min-w-0 space-y-6 xl:col-span-2">
            {/*
              Money only for members who may see it. The API leaves revenue out for check-in
              staff, and cards that printed zero for figures that were not zero were found by QA.
            */}
            {can.financials && (
              <SectionCard
                title="Sales and proceeds"
                description={
                  activeLabel
                    ? `${activeLabel}. Amounts in other currencies are never added in.`
                    : 'No sales yet.'
                }
                action={
                  choices.length > 1 && activeCurrency ? (
                    <SegmentedControl
                      label="Market"
                      options={choices.map((c) => ({ value: c.currency, label: c.label }))}
                      value={activeCurrency}
                      onChange={setMarket}
                    />
                  ) : undefined
                }
              >
                {loading ? (
                  <Skeleton className="h-40 w-full" />
                ) : cash ? (
                  <MoneyBreakdown cash={cash} fmt={fmt} />
                ) : (
                  <p className="text-[0.9375rem] text-text-muted">
                    Sales appear here once your first booking is paid.
                  </p>
                )}
              </SectionCard>
            )}

            <section aria-labelledby="sales-heading">
              <h2
                id="sales-heading"
                className="mb-3 text-[1.0625rem] font-semibold text-text-primary"
              >
                Tickets and attendance
              </h2>
              {loading ? (
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-32 w-full" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
                  <StatCard
                    label="Tickets sold"
                    value={attendance?.issued ?? 0}
                    hint={`${publishedCount} of ${events.length} events published`}
                    icon={Ticket}
                  />
                  <StatCard
                    label="Capacity used"
                    value={`${capacity?.utilization ?? 0}%`}
                    hint={
                      capacity ? `${capacity.sold} of ${capacity.capacity} places sold` : undefined
                    }
                    icon={Users}
                    footer={
                      capacity ? (
                        <Meter
                          label="Capacity used"
                          value={capacity.sold}
                          max={capacity.capacity}
                        />
                      ) : undefined
                    }
                  />
                  <StatCard
                    label="Checked in"
                    value={`${attendance?.checkInRate ?? 0}%`}
                    hint={
                      attendance
                        ? `${attendance.checkedIn} of ${attendance.issued} tickets`
                        : undefined
                    }
                    icon={ScanLine}
                    footer={
                      attendance ? (
                        <Meter
                          label="Tickets checked in"
                          value={attendance.checkedIn}
                          max={attendance.issued}
                        />
                      ) : undefined
                    }
                  />
                  <StatCard
                    label="Bookings completed"
                    value={`${conversion?.rate ?? 0}%`}
                    hint={
                      conversion
                        ? `${conversion.confirmed} of ${conversion.total} bookings`
                        : undefined
                    }
                    icon={Percent}
                  />
                </div>
              )}
            </section>

            {can.financials && (
              <SectionCard
                title="Event performance"
                description={
                  activeLabel
                    ? `Top events by gross sales in ${activeLabel}.`
                    : 'Top events by gross sales.'
                }
                action={
                  <SectionLink href="/organizer/events" srLabel="events">
                    All events
                  </SectionLink>
                }
              >
                {loading ? (
                  <Skeleton className="h-32 w-full" />
                ) : performance.length === 0 ? (
                  <p className="text-[0.9375rem] text-text-muted">
                    No paid bookings in this market yet. Events appear here once they sell.
                  </p>
                ) : (
                  <ol className="space-y-4">
                    {performance.map((e, i) => (
                      <li key={e.eventId} className="min-w-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <Link
                            href={`/organizer/events/${e.eventId}`}
                            className={`min-w-0 truncate text-[0.9375rem] font-medium text-text-primary hover:text-action-primary ${LINK_FOCUS}`}
                          >
                            <span className="mr-2 text-text-muted">{i + 1}.</span>
                            {e.title}
                          </Link>
                          <span className="shrink-0 text-[0.9375rem] font-semibold tabular-nums text-text-primary">
                            {money(e.grossMinor, e.currency)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-3">
                          <div className="flex-1">
                            <Meter
                              label={`${e.title}, gross sales against your best event`}
                              value={e.relative}
                              max={100}
                            />
                          </div>
                          <span className="w-24 shrink-0 text-right text-caption text-text-muted">
                            {e.bookings} {e.bookings === 1 ? 'booking' : 'bookings'}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </SectionCard>
            )}

            <SectionCard
              title="Your events"
              description="The most recently created."
              flush
              action={
                <SectionLink href="/organizer/events" srLabel="events">
                  View all
                </SectionLink>
              }
            >
              {eventsQ.isLoading ? (
                <div className="px-5 pb-3">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : events.length === 0 ? (
                <div className="px-5 pb-3">
                  <EmptyState
                    title="No events yet"
                    hint="Create your first event to start selling tickets."
                    action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
                  />
                </div>
              ) : (
                <ul className="divide-y divide-border border-t border-border">
                  {events.slice(0, 6).map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <Link
                          href={`/organizer/events/${e.id}`}
                          className={`block truncate font-medium text-text-primary hover:text-action-primary ${LINK_FOCUS}`}
                        >
                          {e.title}
                        </Link>
                        <p className="truncate text-caption text-text-muted">
                          {e.venue.city} · {e._count.sessions}{' '}
                          {e._count.sessions === 1 ? 'show' : 'shows'} · {e._count.bookings}{' '}
                          {e._count.bookings === 1 ? 'booking' : 'bookings'}
                        </p>
                      </div>
                      <StatusBadge status={e.status} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            {/*
              Every market side by side. The block above answers "how is this market doing";
              this answers "where am I selling at all, and where are payments failing". Each
              amount is in its own row's currency, and rows are never totalled.
            */}
            {can.financials && markets.length > 0 && (
              <SectionCard title="By market" flush>
                {/*
                  A focusable, named region: on a phone the table scrolls sideways, and a
                  scroll area a keyboard cannot reach is content a keyboard user cannot read.
                */}
                <div
                  className="overflow-x-auto rounded-b-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  tabIndex={0}
                  role="region"
                  aria-label="Sales by market"
                >
                  <table className="w-full text-left text-[0.875rem]">
                    <caption className="sr-only">
                      Sales, refunds, bookings and payment failures for each market
                    </caption>
                    <thead>
                      <tr className="border-y border-border bg-background-subtle text-caption text-text-secondary">
                        <th scope="col" className="whitespace-nowrap px-5 py-2 font-semibold">
                          Market
                        </th>
                        {[
                          'Gross sales',
                          'Net proceeds',
                          'Refunds',
                          'Paid bookings',
                          'All bookings',
                          'Payment failures',
                        ].map((h) => (
                          <th
                            key={h}
                            scope="col"
                            className="whitespace-nowrap px-5 py-2 text-right font-semibold"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {markets.map((m) => (
                        <tr key={m.currency}>
                          <th
                            scope="row"
                            className="whitespace-nowrap px-5 py-2.5 font-medium text-text-primary"
                          >
                            {marketName(m)}
                          </th>
                          <td className="whitespace-nowrap px-5 py-2.5 text-right tabular-nums">
                            {money(m.grossMinor, m.currency)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-2.5 text-right tabular-nums">
                            {money(m.netMinor, m.currency)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-2.5 text-right tabular-nums">
                            {money(m.refundsMinor, m.currency)}
                          </td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{m.paidBookings}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{m.totalBookings}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">
                            {m.paymentFailures}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}
          </div>

          <div className="min-w-0 space-y-6">
            <SectionCard
              title="Coming up"
              description="Your next shows in the coming week, at each venue's local time."
              action={
                <SectionLink href="/organizer/calendar" srLabel="shows">
                  Calendar
                </SectionLink>
              }
            >
              {upcomingQ.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : upcomingQ.isError ? (
                <RetryLine what="your shows" onRetry={() => upcomingQ.refetch()} />
              ) : upcoming.length === 0 ? (
                <p className="text-[0.9375rem] text-text-muted">
                  No shows in the next {COMING_UP_DAYS} days.
                </p>
              ) : (
                <ul className="space-y-4">
                  {upcoming.map((s) => {
                    /*
                      In the zone the show was typed in - the calendar's own rule - so the time
                      here is the time on the wall at the venue, whatever this browser's zone.
                    */
                    const { zone } = sessionZone(s);
                    const day = formatDayLong(localPlace(s.startsAt, zone).day);
                    return (
                      <li key={s.id} className="flex items-start gap-3">
                        <span
                          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-tint-primary text-action-primary"
                          aria-hidden
                        >
                          <CalendarClock className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/organizer/events/${s.event.id}`}
                            className={`block truncate font-medium text-text-primary hover:text-action-primary ${LINK_FOCUS}`}
                          >
                            {s.event.title}
                          </Link>
                          <p className="truncate text-caption text-text-muted">
                            {day}, {formatClock(s.startsAt, zone)} {zoneAbbrev(zone, s.startsAt)} ·{' '}
                            {s.venue.name}
                          </p>
                          {s.event.status !== 'PUBLISHED' && (
                            <div className="mt-1">
                              <StatusBadge status={s.event.status} />
                            </div>
                          )}
                          {s.sold != null && s.capacity ? (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="flex-1">
                                <Meter
                                  label={`${s.event.title}, tickets sold`}
                                  value={s.sold}
                                  max={s.capacity}
                                />
                              </div>
                              <span className="shrink-0 text-caption tabular-nums text-text-muted">
                                {s.sold} of {s.capacity} sold
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>

            <SectionCard
              title="Pending actions"
              description="Problems your notifications say are still open."
              action={
                <SectionLink href="/organizer/notifications" srLabel="notifications">
                  All
                </SectionLink>
              }
            >
              <FeedList
                loading={feedQ.isLoading}
                error={feedQ.isError}
                onRetry={() => feedQ.refetch()}
                groups={pending}
                empty="Nothing needs you right now."
              />
            </SectionCard>

            <SectionCard title="Recent activity">
              <FeedList
                loading={feedQ.isLoading}
                error={feedQ.isError}
                onRetry={() => feedQ.refetch()}
                groups={activity}
                empty="Nothing has happened yet."
              />
            </SectionCard>

            {showPayouts && (
              <SectionCard
                title="Latest payout"
                action={
                  <SectionLink href="/organizer/payouts" srLabel="payouts">
                    Payouts
                  </SectionLink>
                }
              >
                {payoutsQ.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : payoutsQ.isError ? (
                  <RetryLine what="payouts" onRetry={() => payoutsQ.refetch()} />
                ) : latestPayout ? (
                  <dl className="space-y-2 text-[0.9375rem]">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-text-muted">Status</dt>
                      <dd>
                        <StatusBadge status={latestPayout.status} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Net amount</dt>
                      <dd className="font-semibold tabular-nums text-text-primary">
                        {money(latestPayout.netMinor, latestPayout.currency)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Created</dt>
                      <dd className="text-text-secondary">{dateOnly(latestPayout.createdAt)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-[0.9375rem] text-text-muted">
                    No payouts yet. Settlements are made from the Payouts page.
                  </p>
                )}
              </SectionCard>
            )}

            <SectionCard title="Customers">
              {loading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <dl className="space-y-2 text-[0.9375rem]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-muted">Bought again</dt>
                    <dd className="font-semibold tabular-nums text-text-primary">
                      {repeat ? `${repeat.repeatCustomers} of ${repeat.totalCustomers}` : '0'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-muted">Most popular ticket</dt>
                    <dd className="min-w-0 truncate text-right font-semibold text-text-primary">
                      {analytics?.topTicketType
                        ? `${analytics.topTicketType.name} (${analytics.topTicketType.quantity})`
                        : 'None yet'}
                    </dd>
                  </div>
                  {can.financials && cash && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Coupons redeemed</dt>
                      <dd className="text-right font-semibold tabular-nums text-text-primary">
                        {cash.couponRedemptions}
                        {cash.couponRedemptions > 0 && (
                          <span className="font-normal text-text-muted">
                            {' '}
                            ({fmt(cash.couponDiscountMinor)} off)
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </SectionCard>

            <SectionCard title="Shortcuts">
              <ul className="grid gap-2">
                {[
                  { href: '/organizer/bookings', label: 'Find a booking', icon: ClipboardList },
                  { href: '/organizer/gate', label: 'Check in tickets', icon: ScanLine },
                  { href: '/organizer/promotions', label: 'Promote an event', icon: Megaphone },
                  ...(showPayouts
                    ? [{ href: '/organizer/payouts', label: 'View payouts', icon: Banknote }]
                    : []),
                ].map(({ href, label, icon: Icon }) => (
                  <li key={href}>
                    <Link
                      href={href}
                      className="flex min-h-[2.75rem] items-center gap-3 rounded-md border border-border px-3 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Icon className="h-4 w-4 text-action-primary" aria-hidden />
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Gross, what comes off it, and what is left - as the sum it is.
 *
 * Every figure is the API's: `netMinor` is computed server-side as gross less the organizer's
 * fees less completed refunds, and this only lays the parts beside it. If they ever stopped
 * adding up, the screen would show it rather than hide it, which is the point of drawing it.
 */
function MoneyBreakdown({ cash, fmt }: { cash: MarketMoney; fmt: (minor: number) => string }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <p className="text-[0.875rem] font-medium text-text-secondary">Gross sales</p>
          <p className="mt-1 break-words text-[1.75rem] font-bold leading-tight tracking-tight tabular-nums text-text-primary">
            {fmt(cash.grossMinor)}
          </p>
          <p className="mt-1 text-caption text-text-muted">
            What buyers paid for tickets, before anything comes off.
          </p>
        </div>
        <div className="rounded-md border border-action-primary bg-tint-primary p-4">
          <p className="text-[0.875rem] font-semibold text-action-primary">Net proceeds</p>
          <p className="mt-1 break-words text-[1.75rem] font-bold leading-tight tracking-tight tabular-nums text-text-primary">
            {fmt(cash.netMinor)}
          </p>
          <p className="mt-1 text-caption text-text-secondary">
            What is yours, after your fees and refunds.
          </p>
        </div>
      </div>

      <dl className="divide-y divide-border rounded-md border border-border text-[0.9375rem]">
        <div className="flex justify-between gap-3 px-4 py-2.5">
          <dt className="text-text-secondary">Gross sales</dt>
          <dd className="tabular-nums text-text-primary">{fmt(cash.grossMinor)}</dd>
        </div>
        <div className="flex justify-between gap-3 px-4 py-2.5">
          <dt className="text-text-secondary">Less your fees</dt>
          <dd className="tabular-nums text-text-primary">- {fmt(cash.organizerFeesMinor)}</dd>
        </div>
        <div className="flex justify-between gap-3 px-4 py-2.5">
          <dt className="text-text-secondary">
            Less refunds{' '}
            <span className="text-caption text-text-muted">({cash.refundRate}% of gross)</span>
          </dt>
          <dd className="tabular-nums text-text-primary">- {fmt(cash.refundsMinor)}</dd>
        </div>
        <div className="flex justify-between gap-3 rounded-b-md bg-background-subtle px-4 py-2.5 font-semibold">
          <dt className="text-text-primary">Net proceeds</dt>
          <dd className="tabular-nums text-text-primary">{fmt(cash.netMinor)}</dd>
        </div>
      </dl>

      <p className="text-caption text-text-muted">
        Booking fees charged to buyers on these sales: {fmt(cash.bookingFeesMinor)}. They are not
        part of your proceeds.
      </p>
    </div>
  );
}

function RetryLine({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p className="text-[0.9375rem] text-text-muted">
      We could not load {what}.{' '}
      <button
        type="button"
        onClick={onRetry}
        className={`font-medium text-action-primary underline ${LINK_FOCUS}`}
      >
        Try again
      </button>
    </p>
  );
}

/** A short list of feed cards: icon, title, when. Each opens the fix, or the notification centre. */
function FeedList({
  loading,
  error,
  onRetry,
  groups,
  empty,
}: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  groups: ReturnType<typeof pendingActions>;
  empty: string;
}) {
  if (loading) return <Skeleton className="h-20 w-full" />;
  if (error) return <RetryLine what="your notifications" onRetry={onRetry} />;
  if (groups.length === 0) return <p className="text-[0.9375rem] text-text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {groups.map((g) => {
        const Icon = SEVERITY_ICON[g.severity];
        return (
          <li key={g.key}>
            <Link
              href={g.action?.href ?? '/organizer/notifications'}
              className={`group flex items-start gap-3 ${LINK_FOCUS}`}
            >
              <Icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${SEVERITY_TEXT[g.severity]}`}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-[0.9375rem] font-medium text-text-primary group-hover:text-action-primary">
                  {g.title}
                </span>
                <span className="block text-caption text-text-muted">{relativeTime(g.lastAt)}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
