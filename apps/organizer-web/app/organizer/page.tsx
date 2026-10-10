'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Info,
  OctagonAlert,
  Plus,
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
  StatusBadge,
  dateOnly,
  MARKETS,
  marketFor,
  useAuthUser,
  type AnalyticsOrganizerMarket,
  type BadgeTone,
  type NotificationFeedSeverity,
  type OrganizerCalendarSession,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { isForbidden } from '@/lib/org-permissions';
import { relativeTime } from '@/lib/notification-feed-view';
import { formatClock, localPlace, sessionZone, todayKey, zoneAbbrev } from '@/lib/calendar';
import {
  moneyFor,
  pendingActions,
  performanceFor,
  pickCurrency,
  recentActivity,
  comingUp,
  comingUpWindow,
  COMING_UP_DAYS,
  NEXT_SHOW_DAYS,
  nextShowByEvent,
  startingWithin,
  type MarketChoice,
  type MarketMoney,
} from './_dashboard/model';
import {
  eventSelling,
  lifecycleLabel,
  lifecycleTone,
  sellingTone,
  sessionSelling,
  setupSummary,
  type Selling,
  type ShowSaleInput,
  type SetupSummary,
} from './_dashboard/status';

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

/** How many upcoming shows the programme lists before "See the calendar". */
const PROGRAMME_LIMIT = 6;

/**
 * The organizer's Overview, laid out like a venue's programme.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────────────
 * What an organizer opens this page to learn is short: is anything stopping me, what is on
 * this week and is it selling, how much have I sold and how much of it is mine. The page
 * answers in that order. The shows lead; setup and compliance are calm and secondary.
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────────────
 * The owner's review: "excessive prominence to a long compliance checklist", and the console
 * said "Ready to sell" for a DRAFT event. So:
 *
 * - A genuine blocker (money that cannot be paid out) still leads the page. Everything else
 *   that is merely recommended is ONE line, "4 things to set up", that opens into the list.
 * - Every event and show carries three separate statements, never one blended word: where it
 *   is in its life (Draft, In review, Published...), whether it is selling ("Selling" or "Not
 *   selling: <reason>", from the server's own sale check), and the organization's setup. See
 *   `_dashboard/status.ts`, which `status.test.ts` holds to "a draft is never Selling".
 *
 * ── GROSS IS NOT NET ───────────────────────────────────────────────────────────────
 * The difference is drawn as the sum it is - gross, less the fees taken from you, less
 * refunds, equals what you keep - using the API's own figures, per market, never added
 * across currencies. Nothing about the finance model is computed here.
 *
 * ── NOT SHOWN, BECAUSE THE API DOES NOT SAY ────────────────────────────────────────
 * A sales trend over time (the organizer analytics endpoint returns totals, not a series),
 * revenue per upcoming show (the calendar sends sold and capacity, not money), and an
 * all-markets total (there is no exchange rate). Drawing any of them would be inventing it.
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
    everybody's landing page, so the read is skipped for a role that cannot make it, a
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
    organization in the next 60 days (NEXT_SHOW_DAYS), with sold and capacity per show. The week's
    programme is the first seven days of it; the rest is each event's NEXT show, which is what
    "is this event selling" is judged by. The window is fixed at mount so the query key does
    not change on every render.
  */
  const [horizon] = useState(() => comingUpWindow(new Date(), NEXT_SHOW_DAYS));
  const upcomingQ = useQuery({
    queryKey: ['organizer-calendar', activeOrg.id, horizon.from, horizon.to],
    queryFn: () => api.events.calendar(activeOrg.id, horizon.from, horizon.to),
  });
  const feedQ = useQuery({
    queryKey: FEED_KEY,
    queryFn: () => api.notifications.feed('ORGANIZER'),
  });
  // The same key Get started and Settings read, so all three agree on what is left to do.
  const actionsQ = useQuery({
    queryKey: ['organizer', 'actions', activeOrg.id],
    queryFn: () => api.organizations.actions(activeOrg.id),
    staleTime: 30_000,
  });

  const events = useMemo(() => eventsQ.data ?? [], [eventsQ.data]);
  const analytics = analyticsQ.data;
  const loading = eventsQ.isLoading || analyticsQ.isLoading;
  const isError = eventsQ.isError || analyticsQ.isError;
  const upcoming = useMemo(
    () =>
      comingUp(
        startingWithin(upcomingQ.data?.sessions, COMING_UP_DAYS),
        new Date(),
        PROGRAMME_LIMIT,
      ),
    [upcomingQ.data],
  );
  const nextShows = useMemo(() => nextShowByEvent(upcomingQ.data?.sessions), [upcomingQ.data]);
  const recentEvents = useMemo(() => events.slice(0, 6), [events]);

  /*
    ── IS IT SELLING: TWO SERVER CHECKS, BOTH REQUIRED ───────────────────────────────
    1. GET /events/:id/sellability - is the event CONFIGURED so a sale can be made (dates,
       ticket types, seat classes). Cached under the key the event page uses.
    2. GET /organizer-calendar/sale-eligibility - would checkout sell this SHOW now, by the
       sale-eligibility rules it refuses a cart by (#280): state price rules, ceilings. The
       first check does not ask these, and on QA a Telangana cinema show with no state price
       rules read "Selling" while every checkout answered SALE_NOT_OPEN.
    Only PUBLISHED events are asked about at all - a draft answers "Not selling: draft" from
    its status - and only the shows on this page: the week's programme and each listed
    event's next show, a dozen at most.
  */
  const publishedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of upcoming) if (s.event.status === 'PUBLISHED') ids.add(s.event.id);
    for (const e of recentEvents) if (e.status === 'PUBLISHED') ids.add(e.id);
    return [...ids];
  }, [upcoming, recentEvents]);
  const sellabilityQs = useQueries({
    queries: publishedIds.map((id) => ({
      queryKey: ['event-sellability', id],
      queryFn: () => api.events.sellability(id),
      staleTime: 60_000,
      retry: 1,
    })),
  });
  const askedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of upcoming) if (s.event.status === 'PUBLISHED') ids.add(s.id);
    for (const e of recentEvents) {
      const next = nextShows.get(e.id);
      if (e.status === 'PUBLISHED' && next) ids.add(next.id);
    }
    return [...ids].sort();
  }, [upcoming, recentEvents, nextShows]);
  const eligibilityQ = useQuery({
    queryKey: ['organizer-sale-eligibility', activeOrg.id, askedSessionIds.join(',')],
    queryFn: () => api.events.saleEligibility(activeOrg.id, askedSessionIds),
    enabled: askedSessionIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const eligibilityBySession = useMemo(
    () => new Map((eligibilityQ.data?.sessions ?? []).map((e) => [e.sessionId, e])),
    [eligibilityQ.data],
  );

  /** Both checks for one show, in the shape the status rules take. */
  const showInput = (s: OrganizerCalendarSession): ShowSaleInput => {
    const i = publishedIds.indexOf(s.event.id);
    return {
      sessionStatus: s.status,
      startsAt: s.startsAt,
      sold: s.sold,
      capacity: s.capacity,
      sessionId: s.id,
      sellability: i < 0 ? undefined : sellabilityQs[i]?.data,
      eligibility: eligibilityBySession.get(s.id),
    };
  };
  /** A check that could not be read is said as such, never as Selling. */
  const failedFor = (eventId: string) => {
    const i = publishedIds.indexOf(eventId);
    return eligibilityQ.isError || (i >= 0 && !!sellabilityQs[i]?.isError);
  };
  const unknown = (s: Selling, failed: boolean): Selling =>
    failed && s.selling === null && s.label === 'Checking sales'
      ? { selling: null, label: 'Sales status unavailable' }
      : s;

  /*
    ── MONEY IS PER MARKET, AND THE ORGANIZER PICKS WHICH ONE ────────────────────────
    Every market the organization sells in or has a venue in, including one that has taken
    nothing yet. The switch appears only when there is genuinely more than one.
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
  const attendance = analytics?.attendance;
  const performance = performanceFor(analytics, activeCurrency);
  const pending = pendingActions(feedQ.data).slice(0, 4);
  const activity = recentActivity(feedQ.data, 4);
  const latestPayout = payoutsQ.data?.[0];
  const setup = setupSummary(actionsQ.data?.actions);
  const firstName = user?.fullName?.trim().split(/\s+/)[0];

  const header = (
    <PageHeader
      eyebrow="Overview"
      title={activeOrg.name}
      description={`Welcome back${firstName ? `, ${firstName}` : ''}. What is on this week, how it is selling, and anything that needs you.`}
      meta={
        <>
          <StatusBadge status={activeOrg.status} />
          {activeOrg.verified && <Badge tone="success">Verified</Badge>}
          {actionsQ.data && (
            <Badge tone={setup.open === 0 ? 'success' : 'neutral'}>
              {setup.open === 0 && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
              {setup.label}
            </Badge>
          )}
        </>
      }
      action={
        <>
          <Link
            href="/organizer/events"
            className={`hidden px-2 text-[0.9375rem] font-medium text-text-secondary hover:text-text-primary sm:inline ${LINK_FOCUS}`}
          >
            All events
          </Link>
          <ButtonLink href="/organizer/events/new">
            <Plus className="h-4 w-4" aria-hidden />
            Create event
          </ButtonLink>
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
        {/*
          A genuine blocker first: money that cannot reach them is worth reading before a
          chart. It renders nothing when nothing is blocking.
        */}
        <Blockers setup={setup} />

        {/* Everything else still to do: one line, opening into the list. */}
        <SetupChecklist setup={setup} loading={actionsQ.isLoading} />

        {/* Figures for the whole organization, one market's money at a time. */}
        <section aria-labelledby="figures-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="figures-heading" className="sr-only">
              Sales at a glance
            </h2>
            {can.financials && choices.length > 1 && activeCurrency && (
              <SegmentedControl
                label="Market"
                options={choices.map((c) => ({ value: c.currency, label: c.label }))}
                value={activeCurrency}
                onChange={setMarket}
              />
            )}
          </div>
          {loading ? (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[6.5rem] w-full" />
              ))}
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Figure
                /*
                  TWO COUNTS, SAID AS TWO THINGS. The figure is tickets buyers hold now (issued
                  and not refunded, cancelled or voided - the analytics `attendance.issued`).
                  The line under it is the inventory's places sold (`capacity.sold`), a
                  counter the booking and refund paths keep in step with the tickets. They were
                  printed as "41" and "42 of 48,317 places" in one tile, which read as a
                  contradiction; when they differ, a ticket left the valid set without its place
                  going back on sale, and the organizer should see both, labelled.
                */
                label="Tickets sold"
                value={(attendance?.issued ?? 0).toLocaleString('en-IN')}
                hint="Valid tickets buyers hold now"
                detail={
                  capacity && capacity.capacity > 0
                    ? `Places taken: ${capacity.sold.toLocaleString('en-IN')} of ${capacity.capacity.toLocaleString('en-IN')} (${capacity.utilization}%)`
                    : undefined
                }
              />
              {can.financials && (
                <Figure
                  label="Gross sales"
                  value={cash ? fmt(cash.grossMinor) : '-'}
                  hint={activeLabel ? `${activeLabel}, before fees and refunds` : 'No sales yet'}
                />
              )}
              {can.financials && (
                <Figure
                  label="Net proceeds"
                  value={cash ? fmt(cash.netMinor) : '-'}
                  hint="What is yours, after your fees and refunds"
                  accent
                />
              )}
              <Figure
                label="Checked in"
                value={`${attendance?.checkInRate ?? 0}%`}
                hint={
                  attendance
                    ? `${attendance.checkedIn.toLocaleString('en-IN')} of ${attendance.issued.toLocaleString('en-IN')} tickets`
                    : 'No tickets yet'
                }
              />
            </dl>
          )}
        </section>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="min-w-0 space-y-6 xl:col-span-2">
            <SectionCard
              title="This week"
              description={`Your shows in the next ${COMING_UP_DAYS} days, at each venue's local time.`}
              flush
              action={
                <SectionLink href="/organizer/calendar" srLabel="shows">
                  Calendar
                </SectionLink>
              }
            >
              {upcomingQ.isLoading ? (
                <div className="px-5 pb-4">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : upcomingQ.isError ? (
                <div className="px-5 pb-4">
                  <RetryLine what="your shows" onRetry={() => upcomingQ.refetch()} />
                </div>
              ) : upcoming.length === 0 ? (
                <div className="px-5 pb-5">
                  <p className="text-[0.9375rem] text-text-muted">
                    No shows in the next {COMING_UP_DAYS} days.{' '}
                    <Link
                      href="/organizer/events"
                      className={`font-medium text-action-primary underline-offset-2 hover:underline ${LINK_FOCUS}`}
                    >
                      Add dates to an event
                    </Link>
                  </p>
                </div>
              ) : (
                <ol className="divide-y divide-border border-t border-border">
                  {upcoming.map((s) => {
                    return (
                      <ProgrammeRow
                        key={s.id}
                        session={s}
                        selling={unknown(
                          sessionSelling({ ...showInput(s), eventStatus: s.event.status }),
                          failedFor(s.event.id),
                        )}
                      />
                    );
                  })}
                </ol>
              )}
            </SectionCard>

            <SectionCard
              title="Your events"
              description="The most recently created, with where each one stands."
              flush
              action={
                <SectionLink href="/organizer/events" srLabel="events">
                  View all
                </SectionLink>
              }
            >
              {eventsQ.isLoading ? (
                <div className="px-5 pb-4">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : events.length === 0 ? (
                <div className="px-5 pb-4">
                  <EmptyState
                    title="No events yet"
                    hint="Create your first event to start selling tickets."
                    action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
                  />
                </div>
              ) : (
                <ul className="divide-y divide-border border-t border-border">
                  {recentEvents.map((e) => {
                    const next = nextShows.get(e.id);
                    const selling = unknown(
                      eventSelling(
                        e.status,
                        upcomingQ.isLoading ? undefined : next ? showInput(next) : null,
                        NEXT_SHOW_DAYS,
                      ),
                      failedFor(e.id) || upcomingQ.isError,
                    );
                    return (
                      <li
                        key={e.id}
                        className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
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
                          {selling.detail && <ReasonLine text={selling.detail} />}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <Badge tone={lifecycleTone(e.status)}>{lifecycleLabel(e.status)}</Badge>
                          <SellingChip selling={selling} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>

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

            {can.financials && (
              <SectionCard
                title="Event performance"
                description={
                  activeLabel
                    ? `Top events by gross sales in ${activeLabel}.`
                    : 'Top events by gross sales.'
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
                            <span className="mr-2 tabular-nums text-text-muted">{i + 1}.</span>
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
                          <span className="w-24 shrink-0 text-right text-caption tabular-nums text-text-muted">
                            {e.bookings} {e.bookings === 1 ? 'booking' : 'bookings'}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </SectionCard>
            )}

            {/*
              Every market side by side: "where am I selling at all, and where are payments
              failing". Each amount is in its own row's currency, and rows are never totalled.
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
              title="Needs you"
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

            <SectionCard title="Recent activity">
              <FeedList
                loading={feedQ.isLoading}
                error={feedQ.isError}
                onRetry={() => feedQ.refetch()}
                groups={activity}
                empty="Nothing has happened yet."
              />
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One figure in the strip at the top: a label, a big number in the display face, a hint. */
function Figure({
  label,
  value,
  hint,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  hint: string;
  /** A second, separately labelled fact - never a different count of the same thing. */
  detail?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border bg-background-surface px-3.5 py-3 sm:px-4 sm:py-3.5 ${
        accent ? 'border-action-primary/40' : 'border-border'
      }`}
    >
      <dt
        className={`text-[0.8125rem] font-medium ${accent ? 'text-action-primary' : 'text-text-secondary'}`}
      >
        {label}
      </dt>
      <dd className="mt-1 break-words font-display text-[1.1875rem] font-bold sm:text-[1.5rem] leading-tight tracking-tight tabular-nums text-text-primary">
        {value}
      </dd>
      <dd className="mt-0.5 text-caption text-text-muted">{hint}</dd>
      {detail && <dd className="mt-0.5 text-caption text-text-secondary">{detail}</dd>}
    </div>
  );
}

/**
 * "Selling" in the warm marquee accent - the one moment on the page that is about the show
 * being on sale - and every "Not selling" reason in plain words with the warning tone.
 * Never colour alone: the dot and the word both say it.
 */
function SellingChip({ selling }: { selling: Selling }) {
  if (selling.selling === true) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-tint-marquee px-2.5 py-0.5 text-caption font-semibold text-marquee">
        <span className="h-1.5 w-1.5 rounded-full bg-marquee-fill" aria-hidden />
        {selling.label}
      </span>
    );
  }
  const tone: BadgeTone = sellingTone(selling);
  return <Badge tone={tone}>{selling.label}</Badge>;
}

/**
 * The server's own sentence for why something is not selling, under the chip that names it
 * in a few words. Never dropped: "Not selling: no state price rules yet" is only actionable
 * with "Contact support" beside it.
 */
function ReasonLine({ text }: { text: string }) {
  return <p className="mt-1 text-caption text-status-warning">{text}</p>;
}

/** A show in the week's programme: date tile, title, time and place, sales, status. */
function ProgrammeRow({
  session: s,
  selling,
}: {
  session: OrganizerCalendarSession;
  selling: Selling;
}) {
  /*
    In the zone the show was typed in - the calendar's own rule - so the time here is the
    time on the wall at the venue, whatever this browser's zone.
  */
  const { zone } = sessionZone(s);
  const day = localPlace(s.startsAt, zone).day;
  const isToday = day === todayKey(new Date(), zone);
  const date = new Date(`${day}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(
    date,
  );
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(date);
  return (
    <li className="flex gap-4 px-5 py-3.5">
      <div
        className={`flex w-14 shrink-0 flex-col items-center justify-center rounded-md border py-1.5 text-center ${
          isToday ? 'border-marquee-fill bg-tint-marquee' : 'border-border bg-background-subtle'
        }`}
      >
        <span
          className={`text-[0.6875rem] font-semibold uppercase tracking-wide ${isToday ? 'text-marquee' : 'text-text-muted'}`}
        >
          {isToday ? 'Today' : weekday}
        </span>
        <span className="font-display text-[1.25rem] font-bold leading-none tabular-nums text-text-primary">
          {date.getUTCDate()}
        </span>
        <span className="text-[0.6875rem] text-text-muted">{month}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <Link
              href={`/organizer/events/${s.event.id}`}
              className={`block truncate font-medium text-text-primary hover:text-action-primary ${LINK_FOCUS}`}
            >
              {s.event.title}
            </Link>
            <p className="truncate text-caption text-text-muted">
              <span className="tabular-nums">{formatClock(s.startsAt, zone)}</span>{' '}
              {zoneAbbrev(zone, s.startsAt)} · {s.venue.name}
              {s.venue.city ? `, ${s.venue.city}` : ''}
            </p>
            {selling.detail && <ReasonLine text={selling.detail} />}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {/* The lifecycle only when it is news: a published event's row says so by selling. */}
            {s.event.status !== 'PUBLISHED' && (
              <Badge tone={lifecycleTone(s.event.status)}>{lifecycleLabel(s.event.status)}</Badge>
            )}
            <SellingChip selling={selling} />
          </div>
        </div>
        {s.sold != null && s.capacity ? (
          <div className="mt-2 flex items-center gap-3">
            <div className="flex-1">
              <Meter label={`${s.event.title}, tickets sold`} value={s.sold} max={s.capacity} />
            </div>
            <span className="shrink-0 text-caption tabular-nums text-text-secondary">
              {s.sold} of {s.capacity} sold
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * What actually stops something: money that cannot be paid out, an account the platform
 * cannot sell for. Always open, always first, and absent when there is none.
 */
function Blockers({ setup }: { setup: SetupSummary }) {
  if (setup.blockers.length === 0) return null;
  return (
    <section
      aria-labelledby="blockers-heading"
      className="rounded-lg border border-status-error/40 bg-background-surface"
    >
      <div className="flex items-start gap-3 px-5 pt-4">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-tint-error text-status-error"
          aria-hidden
        >
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 id="blockers-heading" className="text-[1.0625rem] font-semibold text-text-primary">
            Needs your attention
          </h2>
          <p className="text-caption text-text-secondary">
            Something here stops the platform doing what you expect.
          </p>
        </div>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {setup.blockers.map((a) => (
          <li key={a.key}>
            <Link
              href={a.fixPath}
              className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text-primary group-hover:text-action-primary">
                  {a.title}
                </p>
                <p className="text-caption text-text-muted">{a.consequence}</p>
              </div>
              <span className="hidden shrink-0 rounded-full bg-tint-error px-2 py-0.5 text-caption font-medium text-status-error sm:inline">
                Blocking
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-caption font-semibold text-action-primary">
                {a.actionLabel}
                <ArrowRight
                  className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                  aria-hidden
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Everything recommended but not blocking, as one line that opens into the list.
 *
 * Closed by default: none of it stops a sale, and the old full-height card made a profile
 * picture look as urgent as a bank account. The count is in the button's name, so it is
 * the first thing a screen reader hears too.
 */
function SetupChecklist({ setup, loading }: { setup: SetupSummary; loading: boolean }) {
  const [open, setOpen] = useState(false);
  if (loading) return <Skeleton className="h-16 w-full" />;
  if (setup.todo.length === 0) return null;
  const listId = 'setup-checklist';
  const TONE: Record<string, string> = {
    IMPORTANT: 'bg-tint-warning text-status-warning',
    SUGGESTED: 'bg-background-subtle text-text-secondary',
  };
  return (
    <section className="rounded-lg border border-border bg-background-surface">
      <h2 className="sr-only">Setup</h2>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-lg px-5 py-4 text-left transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-text-primary">
            {setup.open > 0 ? setup.label : 'Optional extras'}
          </span>
          <span className="block text-caption text-text-muted">
            {setup.blockers.length > 0
              ? 'Recommended. The blocking ones are above.'
              : 'Recommended. None of these stops you selling.'}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      <ul id={listId} hidden={!open} className="divide-y divide-border border-t border-border">
        {setup.todo.map((a) => (
          <li key={a.key}>
            <Link
              href={a.fixPath}
              className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-medium text-text-primary group-hover:text-action-primary">
                  {a.title}
                </p>
                <p className="text-caption text-text-muted">{a.consequence}</p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-caption font-medium ${
                  a.optional ? TONE.SUGGESTED : (TONE[a.severity] ?? TONE.SUGGESTED)
                }`}
              >
                {a.optional ? 'Optional' : a.severity === 'IMPORTANT' ? 'Important' : 'Suggested'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Gross, what comes off it, and what is left - as the sum it is.
 *
 * The two totals themselves lead the page in the figure strip; this card is the working.
 *
 * Every figure is the API's: `netMinor` is computed server-side as gross less the organizer's
 * fees less completed refunds, and this only lays the parts beside it. If they ever stopped
 * adding up, the screen would show it rather than hide it, which is the point of drawing it.
 */
function MoneyBreakdown({ cash, fmt }: { cash: MarketMoney; fmt: (minor: number) => string }) {
  return (
    <div className="space-y-5">
      {/* The two totals are the figures at the top of the page; this is how one becomes the other. */}
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
