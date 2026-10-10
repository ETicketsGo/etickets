'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CalendarClock,
  ChevronDown,
  IndianRupee,
  Ticket,
  Wallet,
} from 'lucide-react';
import {
  api,
  money,
  ErrorState,
  SectionCard,
  SectionLink,
  SegmentedControl,
  Skeleton,
  SkeletonCard,
  StatusBadge,
  dateOnly,
  MARKETS,
  marketFor,
  useAuthUser,
  type AnalyticsOrganizerMarket,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { useWorkspace } from '@/components/workspace-chrome';
import { isForbidden } from '@/lib/org-permissions';
import { startOfMonth, weekStartFor } from '@/lib/calendar';
import type { EventListRow } from '@/components/events/event-list-model';
import {
  COMING_UP_DAYS,
  eventsStartingWithin,
  greetingDate,
  greetingDateShort,
  homeWindow,
  moneyFor,
  monthWindow,
  pendingActions,
  performanceFor,
  pickCurrency,
  recentActivity,
  showsOnDay,
  showsPerDay,
  showsToday,
  upcomingEventCount,
  upcomingEventShows,
  viewerToday,
  type MarketChoice,
  type MarketMoney,
} from './_dashboard/model';
import { sellingOf, setupSummary, type SetupSummary } from './_dashboard/status';
import { WelcomeHero } from './_dashboard/hero';
import { NoUpcomingEvents, UpcomingEventCard } from './_dashboard/upcoming-events';
import { MonthCard } from './_dashboard/month-card';
import { GlanceCard } from './_dashboard/glance-card';
import { ActivityTimeline, QuickActions, quickActionsFor } from './_dashboard/side-panels';

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

/** The notification centre's own react-query key, so this reads its cache, not a second copy. */
const FEED_KEY = ['notifications', 'feed', 'organizer'] as const;

/** Image cards in "Upcoming events": three across on a laptop, a swipeable row on a phone. */
const UPCOMING_CARDS = 3;

const count = (n: number) => n.toLocaleString('en-IN');

/**
 * The organizer's Overview, built to the premium console reference.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────────────
 * What an organizer opens this page to learn is short: is anything stopping me, what is on
 * and is it selling, how much have I sold and how much of it is mine. The page answers in that
 * order: a genuine blocker first, then the welcome and the four figures, then the next events
 * as their artwork, the month with today's shows, and the money in detail.
 *
 * ── THREE STATEMENTS, NEVER ONE BLENDED WORD ───────────────────────────────────────
 * Where an event is in its life (the lifecycle pill on its artwork), whether it is selling
 * (the server's unified sale state, "Partly selling: <reason>" never bare "Selling") and the
 * organization's setup ("<n> things to set up", never "Ready to sell"). See
 * `_dashboard/status.ts`.
 *
 * ── GROSS IS NOT NET ───────────────────────────────────────────────────────────────
 * Two separate figures, per market, never added across currencies; the working (gross, less
 * the fees taken from you, less refunds) is drawn as the sum it is from the API's own figures.
 * Nothing about the finance model is computed here.
 *
 * ── NOT SHOWN, BECAUSE THE API DOES NOT SAY ────────────────────────────────────────
 * The reference's trend deltas ("+12% vs last 30 days"), its sales trend line and its
 * "tickets by category" ring. The organizer analytics endpoint returns totals with no prior
 * period, no time series and no category split, so drawing any of them would be inventing it.
 * "Sales performance" is the per-event gross the API does return, as bars.
 */
export default function OrganizerDashboard() {
  const { activeOrg, can } = useOrg();
  const { doesFilmBusiness } = useWorkspace();
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
    ── ONE CALENDAR READ FOR THE PAGE ─────────────────────────────────────────────────
    The calendar's own endpoint (owners and managers): this month and the next four weeks, with
    sold and capacity per show. It feeds the hero's "shows today", the "this week" count, the
    image cards (each event's next show) and the month card's dots. Fixed at mount so the key
    does not change on every render; another month in the card is its own read.
  */
  const [today] = useState(() => viewerToday());
  const [home] = useState(() => homeWindow(today));
  const homeQ = useQuery({
    queryKey: ['organizer-calendar', activeOrg.id, home.from, home.to],
    queryFn: () => api.events.calendar(activeOrg.id, home.from, home.to),
    enabled: can.financials,
  });
  const calendarOk = can.financials && !isForbidden(homeQ.error);
  const sessions = homeQ.data?.sessions;

  const [month, setMonth] = useState(today);
  const onHomeMonth = startOfMonth(month) === startOfMonth(today);
  const otherMonth = useMemo(() => monthWindow(month), [month]);
  const monthQ = useQuery({
    queryKey: ['organizer-calendar', activeOrg.id, otherMonth.from, otherMonth.to],
    queryFn: () => api.events.calendar(activeOrg.id, otherMonth.from, otherMonth.to),
    enabled: calendarOk && !onHomeMonth,
  });
  const monthSessions = onHomeMonth ? sessions : monthQ.data?.sessions;
  const monthState = onHomeMonth ? homeQ : monthQ;
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

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

  const events = useMemo(() => (eventsQ.data ?? []) as EventListRow[], [eventsQ.data]);
  const eventRow = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const analytics = analyticsQ.data;
  const loading = eventsQ.isLoading || analyticsQ.isLoading;
  const isError = eventsQ.isError || analyticsQ.isError;

  const upcoming = useMemo(
    () => upcomingEventShows(sessions, new Date(), UPCOMING_CARDS),
    [sessions],
  );
  const agenda = useMemo(
    () =>
      selectedDay === null
        ? showsToday(sessions, new Date())
        : showsOnDay(monthSessions, selectedDay),
    [selectedDay, sessions, monthSessions],
  );
  const perDay = useMemo(() => showsPerDay(monthSessions), [monthSessions]);

  /*
    ── IS IT SELLING: ONE SERVER ANSWER ──────────────────────────────────────────────
    The API's unified sale state, built from the facts checkout refuses a cart by. Per EVENT
    for the image cards - judged over ALL its upcoming shows, so an event with one paused date
    among ten reads "Partly selling", never "Selling" - and per SHOW for the day's agenda. This
    page decides nothing about it. A handful of ids, well under the caps.
  */
  const askedEventIds = useMemo(() => upcoming.map((s) => s.event.id).sort(), [upcoming]);
  const eventStatesQ = useQuery({
    queryKey: ['organizer-event-sale-states', activeOrg.id, askedEventIds.join(',')],
    queryFn: () => api.events.saleStates(activeOrg.id, askedEventIds),
    enabled: askedEventIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const eventState = useMemo(
    () => new Map((eventStatesQ.data?.events ?? []).map((e) => [e.eventId, e])),
    [eventStatesQ.data],
  );
  const askedSessionIds = useMemo(
    () =>
      agenda
        .slice(0, 4)
        .map((s) => s.id)
        .sort(),
    [agenda],
  );
  const sessionStatesQ = useQuery({
    queryKey: ['organizer-sale-eligibility', activeOrg.id, askedSessionIds.join(',')],
    queryFn: () => api.events.saleEligibility(activeOrg.id, askedSessionIds),
    enabled: askedSessionIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const sessionState = useMemo(
    () => new Map((sessionStatesQ.data?.sessions ?? []).map((e) => [e.sessionId, e])),
    [sessionStatesQ.data],
  );

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

  const attendance = analytics?.attendance;
  const performance = performanceFor(analytics, activeCurrency);
  const pending = pendingActions(feedQ.data).slice(0, 3);
  const activity = recentActivity(feedQ.data, 4);
  const latestPayout = payoutsQ.data?.[0];
  const setup = setupSummary(actionsQ.data?.actions);
  const firstName = user?.fullName?.trim().split(/\s+/)[0];
  const upcomingCount = upcomingEventCount(events);
  const now = new Date();
  const thisWeek = sessions ? eventsStartingWithin(sessions, COMING_UP_DAYS, now) : null;

  // One sentence about the day, from real counts - or none while they are unknown.
  const todayCount = sessions ? showsToday(sessions, now).length : null;
  const dayLine =
    todayCount === null
      ? undefined
      : todayCount === 0
        ? 'No more shows today'
        : `${count(todayCount)} more ${todayCount === 1 ? 'show' : 'shows'} today`;

  const canCreate = can.financials || can.ownerActions;
  const actions = quickActionsFor({
    canCreate,
    canManage: can.financials,
    doesFilmBusiness,
  });
  const featured = upcoming
    .map((s) => eventRow.get(s.event.id))
    .find((row) => row && (row.imagePath || row.imageVariants));

  const hero = (
    <WelcomeHero
      orgName={activeOrg.name}
      orgStatus={activeOrg.status}
      verified={!!activeOrg.verified}
      firstName={firstName}
      dateLine={greetingDate(now)}
      shortDateLine={greetingDateShort(now)}
      dayLine={dayLine}
      setupOpen={actionsQ.data ? setup.open : null}
      feature={featured ?? null}
    />
  );

  if (isError)
    return (
      <div className="space-y-6">
        {hero}
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
    <div className="space-y-6">
      {/*
        A genuine blocker first: money that cannot reach them is worth reading before anything
        else. It renders nothing when nothing is blocking; the rest of setup is one line.
      */}
      <Attention setup={setup} loading={actionsQ.isLoading} />

      {/* The welcome, with the quick actions beside it on a wide screen. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {hero}
        <QuickActions actions={actions} />
      </div>

      {/* Four figures for the whole organization, one market's money at a time. */}
      <section aria-labelledby="figures-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="figures-heading"
            className="font-display text-[1.0625rem] font-bold text-text-primary"
          >
            At a glance
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
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {Array.from({ length: can.financials ? 4 : 2 }).map((_, i) => (
              <SkeletonCard key={i} variant="stat" label="Loading figures" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <GlanceCard
              /*
                Tickets buyers hold now: issued and not refunded, cancelled or voided (the
                analytics `attendance.issued`), with how many of them have been scanned in.
              */
              icon={Ticket}
              tile="teal"
              label="Tickets sold"
              value={count(attendance?.issued ?? 0)}
              hint={
                attendance && attendance.issued > 0
                  ? `${count(attendance.checkedIn)} checked in (${attendance.checkInRate}%)`
                  : 'Valid tickets buyers hold'
              }
            />
            <GlanceCard
              icon={CalendarClock}
              tile="amber"
              label="Upcoming events"
              value={count(upcomingCount)}
              href="/organizer/events"
              hint={
                thisWeek !== null
                  ? `${count(thisWeek)} in the next 7 days`
                  : 'With a show still to come'
              }
            />
            {can.financials && (
              <GlanceCard
                icon={currencyIcon(activeCurrency)}
                tile="blue"
                label="Gross sales"
                value={cash ? fmt(cash.grossMinor) : '-'}
                hint={cash ? 'Before fees and refunds' : 'No sales yet'}
              />
            )}
            {can.financials && (
              <GlanceCard
                icon={Wallet}
                tile="purple"
                label="Net proceeds"
                value={cash ? fmt(cash.netMinor) : '-'}
                hint="Yours after fees and refunds"
              />
            )}
          </div>
        )}
      </section>

      {/*
        Below the figures, two columns on a wide screen: the events and the money on the left,
        the month, what needs you and what happened on the right. On a narrower screen the
        columns dissolve (`contents`) and `order` interleaves them, so a phone reads the next
        events, then the month, then the activity - and the detailed money after that.
      */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:flex xl:items-start">
        <div className="contents xl:flex xl:min-w-0 xl:flex-1 xl:flex-col xl:gap-6">
          {calendarOk && (
            <section
              aria-labelledby="upcoming-heading"
              className="order-1 min-w-0 md:col-span-2 xl:order-none"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2
                  id="upcoming-heading"
                  className="font-display text-[1.0625rem] font-bold text-text-primary"
                >
                  Upcoming events
                </h2>
                <SectionLink href="/organizer/events" srLabel="events">
                  View all
                </SectionLink>
              </div>
              {homeQ.isLoading ? (
                <div className="grid gap-4 md:grid-cols-3">
                  {Array.from({ length: UPCOMING_CARDS }).map((_, i) => (
                    <SkeletonCard
                      key={i}
                      variant="media"
                      label="Loading events"
                      className={i > 0 ? 'hidden md:block' : ''}
                    />
                  ))}
                </div>
              ) : homeQ.isError ? (
                <ErrorState
                  message="We could not load your upcoming shows."
                  onRetry={() => homeQ.refetch()}
                />
              ) : upcoming.length === 0 ? (
                <NoUpcomingEvents canCreate={canCreate} />
              ) : (
                /*
                  A row that swipes on a phone - each card most of the width, so the next one
                  peeks in and says there is more - and three columns from a tablet up.
                */
                <ul
                  className="relative -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:-mx-6 sm:px-6 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 md:pb-0"
                  aria-label="Your next events"
                >
                  {upcoming.map((s, i) => (
                    <li
                      key={s.event.id}
                      className="flex w-[78%] max-w-[20rem] shrink-0 snap-start md:w-auto md:max-w-none"
                    >
                      <UpcomingEventCard
                        show={s}
                        row={eventRow.get(s.event.id)}
                        selling={sellingOf(eventState.get(s.event.id), eventStatesQ.isError)}
                        priority={i === 0}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {can.financials && (
            <div className="order-5 grid min-w-0 gap-6 md:col-span-2 lg:grid-cols-2 xl:order-none">
              <SectionCard
                title="Sales performance"
                description={
                  activeLabel
                    ? `Top events by gross sales, ${activeLabel}`
                    : 'Top events by gross sales'
                }
                action={
                  <SectionLink href="/organizer/finance" srLabel="finance">
                    Finance
                  </SectionLink>
                }
              >
                {loading ? (
                  <Skeleton className="h-40 w-full" />
                ) : performance.length === 0 ? (
                  <p className="text-caption text-text-muted">
                    No paid bookings in this market yet. Events appear here once they sell.
                  </p>
                ) : (
                  <ol className="space-y-3.5">
                    {performance.map((e, i) => (
                      <li key={e.eventId} className="min-w-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <Link
                            href={`/organizer/events/${e.eventId}`}
                            className="min-w-0 truncate rounded-sm text-ui font-medium text-text-primary hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={e.title}
                          >
                            <span className="mr-1.5 tabular-nums text-text-muted">{i + 1}.</span>
                            {e.title}
                          </Link>
                          <span className="shrink-0 text-ui font-semibold tabular-nums text-text-primary">
                            {money(e.grossMinor, e.currency)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-3">
                          {/* The bar is the figure beside it, drawn: decoration for assistive tech. */}
                          <div
                            aria-hidden
                            className="h-2 flex-1 overflow-hidden rounded-full bg-background-subtle"
                          >
                            <div
                              className="h-full rounded-full bg-action-primary"
                              style={{ width: `${Math.max(e.relative, 2)}%` }}
                            />
                          </div>
                          <span className="w-[5.5rem] shrink-0 text-right text-micro tabular-nums text-text-muted">
                            {count(e.bookings)} {e.bookings === 1 ? 'booking' : 'bookings'}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </SectionCard>

              <SectionCard
                title="Gross to net"
                description={
                  activeLabel
                    ? `${activeLabel}. Other currencies are never added in.`
                    : 'No sales yet.'
                }
              >
                {loading ? (
                  <Skeleton className="h-40 w-full" />
                ) : cash ? (
                  <MoneyBreakdown cash={cash} fmt={fmt} />
                ) : (
                  <p className="text-caption text-text-muted">
                    Sales appear here once your first booking is paid.
                  </p>
                )}
              </SectionCard>
            </div>
          )}

          {/*
            Every market side by side: "where am I selling at all, and where are payments
            failing". Each amount is in its own row's currency, and rows are never totalled.
          */}
          {can.financials && markets.length > 0 && (
            <div className="order-6 min-w-0 md:col-span-2 xl:order-none">
              <SectionCard title="By market" flush>
                {/*
                  A focusable, named region: on a phone the table scrolls sideways, and a
                  scroll area a keyboard cannot reach is content a keyboard user cannot read.
                */}
                {/*
                  On a phone, one small card per market: seven columns do not fit 320px, and a
                  table cut off mid-word at the screen edge reads as broken, not as scrollable.
                */}
                <ul className="divide-y divide-border border-t border-border sm:hidden">
                  {markets.map((m) => (
                    <li key={m.currency} className="px-4 py-3">
                      <p className="text-ui font-semibold text-text-primary">{marketName(m)}</p>
                      <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 text-caption min-[360px]:grid-cols-2">
                        {(
                          [
                            ['Gross sales', money(m.grossMinor, m.currency)],
                            ['Net proceeds', money(m.netMinor, m.currency)],
                            ['Refunds', money(m.refundsMinor, m.currency)],
                            ['Paid bookings', String(m.paidBookings)],
                            ['All bookings', String(m.totalBookings)],
                            ['Payment failures', String(m.paymentFailures)],
                          ] as const
                        ).map(([term, value]) => (
                          <div key={term} className="flex min-w-0 justify-between gap-2">
                            <dt className="text-text-muted">{term}</dt>
                            <dd className="tabular-nums text-text-primary">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </li>
                  ))}
                </ul>
                <div
                  className="hidden overflow-x-auto rounded-b-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
                  tabIndex={0}
                  role="region"
                  aria-label="Sales by market"
                >
                  <table className="w-full text-left text-ui">
                    <caption className="sr-only">
                      Sales, refunds, bookings and payment failures for each market
                    </caption>
                    <thead>
                      <tr className="border-y border-border bg-background-subtle text-micro uppercase tracking-wide text-text-secondary">
                        <th scope="col" className="whitespace-nowrap px-5 py-2.5 font-semibold">
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
                            className="whitespace-nowrap px-5 py-2.5 text-right font-semibold"
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
                            className="whitespace-nowrap px-5 py-3 font-medium text-text-primary"
                          >
                            {marketName(m)}
                          </th>
                          <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums">
                            {money(m.grossMinor, m.currency)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums">
                            {money(m.netMinor, m.currency)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums">
                            {money(m.refundsMinor, m.currency)}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums">{m.paidBookings}</td>
                          <td className="px-5 py-3 text-right tabular-nums">{m.totalBookings}</td>
                          <td className="px-5 py-3 text-right tabular-nums">{m.paymentFailures}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            </div>
          )}
        </div>

        <div className="contents xl:flex xl:w-[22rem] xl:shrink-0 xl:flex-col xl:gap-6">
          {calendarOk && (
            <div className="order-2 min-w-0 xl:order-none">
              <MonthCard
                month={month}
                onMonth={(next) => {
                  setMonth(next);
                  setSelectedDay(null);
                }}
                today={today}
                selected={selectedDay}
                onSelect={setSelectedDay}
                weekStart={weekStartFor(activeOrg.registeredCountry)}
                perDay={perDay}
                loading={monthState.isLoading}
                failed={monthState.isError}
                onRetry={() => monthState.refetch()}
                agenda={agenda}
                agendaLoading={selectedDay === null ? homeQ.isLoading : monthState.isLoading}
                sellingFor={(id) => sellingOf(sessionState.get(id), sessionStatesQ.isError)}
              />
            </div>
          )}

          <div className="order-3 min-w-0 space-y-6 xl:order-none">
            {/* What the notifications say is still open - only when something is. */}
            {(pending.length > 0 || feedQ.isError) && (
              <ActivityTimeline
                title="Needs you"
                groups={pending}
                loading={false}
                error={feedQ.isError}
                onRetry={() => feedQ.refetch()}
                empty="Nothing needs you right now."
              />
            )}
            <ActivityTimeline
              title="Recent activity"
              groups={activity}
              loading={feedQ.isLoading}
              error={feedQ.isError}
              onRetry={() => feedQ.refetch()}
              empty="Nothing has happened yet."
            />
          </div>

          {showPayouts && (
            <div className="order-7 min-w-0 xl:order-none">
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
                  <p className="text-caption text-text-muted">
                    We could not load payouts.{' '}
                    <button
                      type="button"
                      onClick={() => payoutsQ.refetch()}
                      className="rounded-sm font-semibold text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Try again
                    </button>
                  </p>
                ) : latestPayout ? (
                  <dl className="space-y-2.5 text-ui">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-text-muted">Status</dt>
                      <dd>
                        <StatusBadge status={latestPayout.status} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Net amount</dt>
                      <dd className="font-display text-[1.0625rem] font-bold tabular-nums text-text-primary">
                        {money(latestPayout.netMinor, latestPayout.currency)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Created</dt>
                      <dd className="text-text-secondary">{dateOnly(latestPayout.createdAt)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-caption text-text-muted">
                    No payouts yet. Settlements are made from the Payouts page.
                  </p>
                )}
              </SectionCard>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The rupee sign on a rupee figure; any other currency gets a neutral banknote. */
function currencyIcon(currency: string | null) {
  return currency === 'INR' ? IndianRupee : Banknote;
}

/**
 * What actually stops something - money that cannot be paid out, an account the platform
 * cannot sell for - always open and first; and everything merely recommended folded into one
 * line, "<n> things to set up", that opens into the list. Nothing at all when nothing is open.
 *
 * The old Overview put a bank account nobody can be paid without and a profile picture in one
 * tall red-bordered card above everything else, so the page opened on a compliance checklist.
 */
function Attention({ setup, loading }: { setup: SetupSummary; loading: boolean }) {
  const [open, setOpen] = useState(false);
  if (loading) return null;
  if (setup.blockers.length === 0 && setup.todo.length === 0) return null;
  const listId = 'setup-checklist';
  const blocked = setup.blockers.length > 0;
  const TONE: Record<string, string> = {
    IMPORTANT: 'bg-tint-warning text-status-warning',
    SUGGESTED: 'bg-background-subtle text-text-secondary',
  };
  /*
    The "<n> things to set up" switch. In the blocker strip's header when there is one (so the
    whole panel is two short rows), on its own slim card when there is not.
  */
  const toggle = setup.todo.length > 0 && (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => setOpen((o) => !o)}
      className="inline-flex min-h-[2.25rem] shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-caption font-semibold text-text-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{setup.open > 0 ? setup.label : 'Optional extras'}</span>
      <ChevronDown
        className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        aria-hidden
      />
    </button>
  );
  return (
    <div
      className={`overflow-hidden rounded-lg border bg-background-surface shadow-xs ${
        blocked ? 'border-status-error/40' : 'border-border'
      }`}
    >
      {blocked ? (
        <section aria-labelledby="blockers-heading">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border bg-tint-error/40 px-4 py-2 sm:px-5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-status-error" aria-hidden />
            <h2 id="blockers-heading" className="text-ui font-bold text-text-primary">
              Needs your attention
            </h2>
            <p className="hidden text-caption text-text-secondary md:block">
              Something here stops the platform doing what you expect.
            </p>
            <span className="-mr-2.5 ml-auto">{toggle}</span>
          </div>
          <ul className="divide-y divide-border">
            {setup.blockers.map((a) => (
              <li key={a.key}>
                <Link
                  href={a.fixPath}
                  className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-nowrap sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <p className="text-ui font-semibold text-text-primary group-hover:text-action-primary">
                      {a.title}
                    </p>
                    <p className="text-caption text-text-muted">{a.consequence}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-tint-error px-2 py-0.5 text-micro font-semibold text-status-error">
                    Blocking
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-tint-primary px-3 py-1.5 text-caption font-semibold text-action-primary">
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
      ) : (
        <section className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 sm:px-5">
          <h2 className="sr-only">Setup</h2>
          <p className="min-w-0 text-caption text-text-muted">
            Recommended. None of these stops you selling.
          </p>
          {toggle}
        </section>
      )}
      {setup.todo.length > 0 && (
        <ul id={listId} hidden={!open} className="divide-y divide-border border-t border-border">
          {setup.todo.map((a) => (
            <li key={a.key}>
              <Link
                href={a.fixPath}
                className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-ui font-medium text-text-primary group-hover:text-action-primary">
                    {a.title}
                  </p>
                  <p className="text-caption text-text-muted">{a.consequence}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-micro font-semibold ${
                    a.optional ? TONE.SUGGESTED : (TONE[a.severity] ?? TONE.SUGGESTED)
                  }`}
                >
                  {a.optional ? 'Optional' : a.severity === 'IMPORTANT' ? 'Important' : 'Suggested'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
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
    <div className="space-y-4">
      <dl className="divide-y divide-border overflow-hidden rounded-md border border-border text-ui">
        <div className="flex justify-between gap-3 px-4 py-2.5">
          <dt className="text-text-secondary">Gross sales</dt>
          <dd className="tabular-nums text-text-primary">{fmt(cash.grossMinor)}</dd>
        </div>
        <div className="flex justify-between gap-3 px-4 py-2.5">
          <dt className="text-text-secondary">Less your fees</dt>
          <dd className="whitespace-nowrap tabular-nums text-text-primary">
            - {fmt(cash.organizerFeesMinor)}
          </dd>
        </div>
        <div className="flex justify-between gap-3 px-4 py-2.5">
          <dt className="text-text-secondary">
            Less refunds{' '}
            <span className="text-micro text-text-muted">({cash.refundRate}% of gross)</span>
          </dt>
          <dd className="whitespace-nowrap tabular-nums text-text-primary">
            - {fmt(cash.refundsMinor)}
          </dd>
        </div>
        <div className="flex justify-between gap-3 bg-tint-primary px-4 py-3 font-semibold">
          <dt className="text-text-primary">Net proceeds</dt>
          <dd className="font-display tabular-nums text-text-primary">{fmt(cash.netMinor)}</dd>
        </div>
      </dl>
      <p className="text-caption text-text-muted">
        Booking fees charged to buyers on these sales: {fmt(cash.bookingFeesMinor)}. They are not
        part of your proceeds.
      </p>
    </div>
  );
}
