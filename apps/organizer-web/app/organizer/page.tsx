'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, CheckCheck, FileClock, Ticket, TriangleAlert } from 'lucide-react';
import {
  api,
  money,
  ErrorState,
  SectionCard,
  SectionLink,
  Skeleton,
  SkeletonCard,
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
  monthWindow,
  pendingActions,
  performanceFor,
  recentActivity,
  showsOnDay,
  showsToday,
  viewerToday,
} from './_dashboard/model';
import {
  KPI_DEFINITIONS,
  UPCOMING_ROWS,
  latestDraft,
  moneyPanels,
  needsAction,
  notYetOnSale,
  upcomingMode,
  upcomingPublishedCount,
  upcomingPublishedShows,
} from './_dashboard/overview-model';
import { sellingOf, setupSummary } from './_dashboard/status';
import { WelcomeBand } from './_dashboard/hero';
import { UpcomingEventCard } from './_dashboard/upcoming-events';
import {
  EventRow,
  FeaturedEventCard,
  NoUpcomingEvents,
  hasOwnArtwork,
} from './_dashboard/event-rows';
import { NotYetOnSale, NOT_YET_SHOWN } from './_dashboard/not-yet-on-sale';
import { NeedsActionCard } from './_dashboard/needs-action';
import { KpiRow, type Kpi } from './_dashboard/kpis';
import { MoneyPanelCard, marketTitle } from './_dashboard/money-panel';
import { MonthCard } from './_dashboard/month-card';
import {
  ActivityTimeline,
  FoldButton,
  QuickActions,
  quickActionsFor,
} from './_dashboard/side-panels';

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

const count = (n: number) => n.toLocaleString('en-IN');

/**
 * The organizer's Overview: an adaptive page that is as long as what the organizer has.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────────────
 * What an organizer opens this page to learn is short: is anything stopping me, what is on and
 * is it selling, how much have I sold and where is the money. The page answers in that order:
 * a one-line welcome, what needs action (blocking first), the quick actions, four figures each
 * defined in a line, the events, and one panel of sales and proceeds per currency.
 *
 * ── IT ADAPTS TO WHAT IS THERE ─────────────────────────────────────────────────────
 * Upcoming events are one featured card when there is one, image cards when there are two or
 * three with artwork of their own, and compact rows otherwise - so one event is not a lone small
 * card beside a screen of nothing, and eight events are not eight identical placeholders. Drafts
 * and events in review are a separate "Not yet on sale" group: they were listed as upcoming
 * events, beside ones buyers can purchase. Nothing is empty-looking: no published event yet offers
 * the newest draft and Create event. The rules are in `_dashboard/overview-model.ts`, tested.
 *
 * ── THREE STATEMENTS, NEVER ONE BLENDED WORD ───────────────────────────────────────
 * Where an event is in its life (the lifecycle pill), whether it is selling (the server's unified
 * sale state, "Partly selling: <reason>" never bare "Selling") and the organization's setup
 * ("<n> things to set up", never "Ready to sell"). See `_dashboard/status.ts`.
 *
 * ── SOLD IS NOT PAYABLE ────────────────────────────────────────────────────────────
 * Per currency, one panel in two groups: what was sold and what is the organizer's of it (the
 * analytics), and where the money stands in the payout ledger (held, payable now, in a payout,
 * paid). The groups are never summed and proceeds are never called payable. Currencies are never
 * added together. Nothing about the finance model is computed here.
 *
 * ── NOT SHOWN, BECAUSE THE API DOES NOT SAY ────────────────────────────────────────
 * The reference's trend deltas ("+12% vs last 30 days"), its sales trend line and its
 * "tickets by category" ring. The organizer analytics endpoint returns totals with no prior
 * period, no time series and no category split, so drawing any of them would be inventing it.
 */
export default function OrganizerDashboard() {
  const { activeOrg, can } = useOrg();
  const { doesFilmBusiness } = useWorkspace();
  const { user } = useAuthUser();

  const eventsQ = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });
  // Single aggregate call for the whole organization (no per-event fan-out).
  const analyticsQ = useQuery({
    queryKey: ['analytics', 'organizer', activeOrg.id],
    queryFn: () => api.analytics.organizer(activeOrg.id),
  });
  /*
    The payout ledger's position. Financial data the API refuses to check-in staff - but this is
    everybody's landing page, so the read is skipped for a role that cannot make it, a refusal
    hides the ledger half of the money panel, and it never decides whether the rest renders.
  */
  const summaryQ = useQuery({
    queryKey: ['payouts', 'summary', activeOrg.id],
    queryFn: () => api.payouts.summary(activeOrg.id),
    enabled: can.financials,
    retry: (n, error) => !isForbidden(error) && n < 2,
  });
  const ledger = can.financials && !isForbidden(summaryQ.error) ? summaryQ.data : undefined;

  /*
    ── ONE CALENDAR READ FOR THE PAGE ─────────────────────────────────────────────────
    The calendar's own endpoint (owners and managers): this month and the next four weeks, with
    sold and capacity per show. It feeds the "next 7 days" count, the events' next shows and the
    month card's dots. Fixed at mount so the key does not change on every render; another month
    in the card is its own read.
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

  // Published events only: a draft is not "upcoming", it is under "Not yet on sale".
  const upcoming = useMemo(
    () => upcomingPublishedShows(sessions, new Date(), UPCOMING_ROWS),
    [sessions],
  );
  const upcomingTotal = upcomingPublishedCount(events);
  const mode = upcomingMode(
    upcoming.map((s) => ({ hasImage: hasOwnArtwork(eventRow.get(s.event.id)) })),
  );
  const notYet = useMemo(() => notYetOnSale(events), [events]);
  const draft = useMemo(() => latestDraft(events), [events]);

  const agenda = useMemo(
    () =>
      selectedDay === null
        ? showsToday(sessions, new Date())
        : showsOnDay(monthSessions, selectedDay),
    [selectedDay, sessions, monthSessions],
  );

  /*
    ── IS IT SELLING: ONE SERVER ANSWER ──────────────────────────────────────────────
    The API's unified sale state, built from the facts checkout refuses a cart by. Per EVENT
    for the upcoming events - judged over ALL its upcoming shows, so an event with one paused date
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
    ── MONEY IS PER CURRENCY: ONE PANEL EACH ─────────────────────────────────────────
    Every market the organization sells in or has a venue in is known to the page, but a panel is
    drawn only for a currency that has money in it (the home market first); none at all draws the
    home market's empty panel. Currencies are never added together.
  */
  const markets: AnalyticsOrganizerMarket[] = analytics?.markets ?? [];
  const knownCurrencies =
    markets.length > 0
      ? markets.map((m) => m.currency)
      : (analytics?.revenue ?? []).map((r) => r.currency);
  const homeCurrency = marketFor(activeOrg.registeredCountry ?? '')?.currency ?? null;
  const panels = useMemo(
    () => (can.financials ? moneyPanels(analytics, ledger, homeCurrency, knownCurrencies) : []),
    // knownCurrencies is derived from analytics, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can.financials, analytics, ledger, homeCurrency],
  );
  const topCurrency = panels[0]?.currency ?? null;
  const activeLabel = topCurrency ? marketTitle(topCurrency) : null;
  const performance = performanceFor(analytics, topCurrency);

  const attendance = analytics?.attendance;
  const pendingAll = pendingActions(feedQ.data);
  const needs = needsAction(actionsQ.data?.actions, pendingAll);
  const [more, setMore] = useState(false);
  const calendarFoldId = useId();
  const detailFoldId = useId();
  const marketsFoldId = useId();
  const otherMoneyId = useId();
  const activity = recentActivity(feedQ.data, 3);
  const setup = setupSummary(actionsQ.data?.actions);
  const firstName = user?.fullName?.trim().split(/\s+/)[0];
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

  const band = (
    <WelcomeBand
      orgName={activeOrg.name}
      orgStatus={activeOrg.status}
      verified={!!activeOrg.verified}
      firstName={firstName}
      dateLine={greetingDate(now)}
      shortDateLine={greetingDateShort(now)}
      dayLine={dayLine}
      setupOpen={actionsQ.data ? setup.open : null}
    />
  );

  if (isError)
    return (
      <div className="space-y-6">
        {band}
        <ErrorState
          message="We could not load your overview. Please try again."
          onRetry={() => {
            eventsQ.refetch();
            analyticsQ.refetch();
          }}
        />
      </div>
    );

  /*
    ── THE FIRST PAINT IS THE PAGE ────────────────────────────────────────────────────
    Until the reads that decide the page's shape have answered, one skeleton shaped like the
    page stands in for all of it. Painting the parts as each read landed is what moved the page:
    the setup panel arrived above everything and pushed it down, the figures grew from their
    placeholders. A read the viewer's role does not make is not waited for (a disabled query is
    not loading).
  */
  const booting =
    eventsQ.isLoading ||
    analyticsQ.isLoading ||
    actionsQ.isLoading ||
    homeQ.isLoading ||
    feedQ.isLoading ||
    summaryQ.isLoading;
  if (booting) return <OverviewSkeleton financials={can.financials} />;

  /* ── THE SECTIONS, each built once and placed once below. ── */
  const kpis: Kpi[] = [
    {
      key: 'upcoming',
      label: 'Upcoming events',
      value: count(upcomingTotal),
      definition: KPI_DEFINITIONS.upcoming,
      fact: thisWeek !== null ? `${count(thisWeek)} in the next 7 days` : undefined,
      icon: CalendarClock,
      tile: 'teal',
      href: '/organizer/events',
    },
    {
      key: 'not-yet',
      label: 'Not yet on sale',
      value: count(notYet.length),
      definition: KPI_DEFINITIONS.notYet,
      icon: FileClock,
      tile: 'amber',
      href: '/organizer/events',
    },
    {
      key: 'tickets',
      label: 'Tickets sold',
      value: count(attendance?.issued ?? 0),
      definition: KPI_DEFINITIONS.tickets,
      fact:
        attendance && attendance.issued > 0
          ? `${count(attendance.checkedIn)} checked in (${attendance.checkInRate}%)`
          : undefined,
      icon: Ticket,
      tile: 'blue',
    },
    {
      key: 'needs-action',
      label: 'Needs action',
      value: count(needs.items.length),
      definition: KPI_DEFINITIONS.needsAction,
      fact:
        needs.items.length === 0
          ? 'All clear'
          : `${count(needs.blocking)} blocking, ${count(needs.warnings)} ${needs.warnings === 1 ? 'warning' : 'warnings'}`,
      icon: needs.items.length === 0 ? CheckCheck : TriangleAlert,
      tile: needs.blocking > 0 ? 'rose' : needs.items.length > 0 ? 'amber' : 'teal',
      alert: needs.blocking > 0,
    },
  ];

  const upcomingSection = calendarOk ? (
    <section aria-labelledby="upcoming-heading" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2
          id="upcoming-heading"
          className="font-display text-[1.0625rem] font-bold text-text-primary"
        >
          Upcoming events
          <span className="ml-1.5 text-ui font-semibold tabular-nums text-text-muted">
            ({count(upcomingTotal)})
          </span>
        </h2>
        <SectionLink href="/organizer/events" srLabel="events">
          View all
        </SectionLink>
      </div>
      {homeQ.isLoading ? (
        <SkeletonCard variant="media" label="Loading events" />
      ) : homeQ.isError ? (
        <ErrorState
          message="We could not load your upcoming shows."
          onRetry={() => homeQ.refetch()}
        />
      ) : mode === 'empty' ? (
        <NoUpcomingEvents canCreate={canCreate} draft={draft} later={upcomingTotal} />
      ) : mode === 'featured' ? (
        <FeaturedEventCard
          show={upcoming[0]}
          row={eventRow.get(upcoming[0].event.id)}
          selling={sellingOf(eventState.get(upcoming[0].event.id), eventStatesQ.isError)}
          priority
        />
      ) : mode === 'cards' ? (
        /*
          Two or three events that each have their own artwork: image cards side by side from a
          tablet up, and a swipeable row on a phone - each compact card most of the width, so
          the next one peeks in and says there is more.
        */
        <ul
          className="relative -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:thin] sm:-mx-6 sm:scroll-px-6 sm:px-6 md:mx-0 md:grid md:grid-cols-[repeat(auto-fit,minmax(0,1fr))] md:gap-4 md:overflow-visible md:px-0 md:pb-0"
          aria-label="Your next events"
        >
          {upcoming.map((s, i) => (
            <li
              key={s.event.id}
              className="flex w-[86%] max-w-[22rem] shrink-0 snap-start md:w-auto md:min-w-0 md:max-w-none"
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
      ) : (
        <ul
          className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs"
          aria-label="Your next events"
        >
          {upcoming.map((s, i) => (
            <li key={s.event.id} className={`min-w-0 ${i >= 3 ? 'max-lg:hidden' : ''}`}>
              <EventRow
                show={s}
                row={eventRow.get(s.event.id)}
                selling={sellingOf(eventState.get(s.event.id), eventStatesQ.isError)}
              />
            </li>
          ))}
          {upcomingTotal > upcoming.length && (
            <li className="bg-background-subtle/50 px-4 py-2 text-caption text-text-muted">
              <Link
                href="/organizer/events"
                className="rounded-sm font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                View all {count(upcomingTotal)} upcoming events
              </Link>
            </li>
          )}
        </ul>
      )}
    </section>
  ) : null;

  const notYetSection = (
    <NotYetOnSale events={notYet.slice(0, NOT_YET_SHOWN)} total={notYet.length} />
  );

  const activityCard = (
    <ActivityTimeline
      title="Recent activity"
      groups={activity}
      loading={feedQ.isLoading}
      error={feedQ.isError}
      onRetry={() => feedQ.refetch()}
      empty="Nothing has happened yet."
      compact
    />
  );

  const monthCard = calendarOk ? (
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
      shows={monthSessions}
      loading={monthState.isLoading}
      failed={monthState.isError}
      onRetry={() => monthState.refetch()}
      agenda={agenda}
      agendaLoading={selectedDay === null ? homeQ.isLoading : monthState.isLoading}
      sellingFor={(id) => sellingOf(sessionState.get(id), sessionStatesQ.isError)}
    />
  ) : null;

  /* ── Sales and proceeds: one panel per currency, then the top events and the by-market table. ── */
  const moneyCard = (p: (typeof panels)[number], first: boolean) => (
    <MoneyPanelCard
      key={p.currency}
      panel={p}
      excludedProviderEvents={ledger?.excluded.providerSettledEvents ?? 0}
      showFinanceLink={first}
    />
  );
  const moneyFirst = can.financials && panels.length > 0 ? moneyCard(panels[0], true) : null;
  /*
    The other currencies. From a tablet up they follow the first panel; on a phone they are
    behind "Show more" and ordered AFTER its button, so opening them does not push the button
    away from under the thumb that pressed it.
  */
  const moneyRest =
    can.financials && panels.length > 1 ? (
      <div
        id={otherMoneyId}
        className={`order-8 min-w-0 space-y-4 md:order-10 xl:order-none ${more ? '' : 'max-xl:hidden'}`}
      >
        {panels.slice(1).map((p) => moneyCard(p, false))}
      </div>
    ) : null;

  const salesCard = can.financials ? (
    <SectionCard
      title="Sales performance"
      description={
        activeLabel ? `Top events by gross sales, ${activeLabel}` : 'Top events by gross sales'
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
  ) : null;

  /*
    Every market side by side: "where am I selling at all, and where are payments failing".
    Each amount is in its own row's currency, and rows are never totalled.
  */
  const marketsCard =
    can.financials && markets.length > 0 ? (
      <SectionCard title="By market" flush>
        {/*
          On a phone, one small card per market: seven columns do not fit 320px, and a table
          cut off mid-word at the screen edge reads as broken, not as scrollable.
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
        {/*
          A focusable, named region: the table can scroll sideways, and a scroll area a keyboard
          cannot reach is content a keyboard user cannot read.
        */}
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
    ) : null;

  const showDetail = !!salesCard;
  const phoneParts = [
    panels.length > 1 && 'other currencies',
    monthCard && 'calendar',
    'recent activity',
    salesCard && 'top events',
    marketsCard && 'markets',
  ].filter((p): p is string => typeof p === 'string');
  const tabletParts = phoneParts.filter((p) =>
    ['other currencies', 'top events', 'markets'].includes(p),
  );
  const toggle = () => setMore((o) => !o);
  const detailIds = [showDetail && detailFoldId, marketsCard && marketsFoldId].filter(Boolean);

  /*
    ── ONE ORDER FOR EVERY WIDTH ──────────────────────────────────────────────────────
    The sections are in the page ONCE, and CSS arranges them per width. Nothing is decided by a
    script after the first paint, so nothing jumps: the old page asked `matchMedia` after
    hydration and a phone first painted the desktop's order.

    - Phone, one column: welcome, what needs action, quick actions, the figures, the events, the
      not-yet-on-sale group, the money - then one "Show more" for the month, the activity, the
      top events and the markets. Folded, not removed: one tap away.
    - Tablet: the same, roomier; the month and the activity side by side are shown, and only the
      top events and the markets are behind "Show more".
    - Wide screen: welcome, quick actions and the figures across the page, then the events and
      the money on the left with what needs action, the month and the activity on the right, and
      the by-market table across the bottom. Everything is open; the fold buttons are not drawn.

    The wrappers are `display: contents` below the wide layout so every section is one flex item
    of the page and `order` can interleave the right column's sections with the left's; at the
    wide layout they become the two columns.
  */
  return (
    <div className="flex flex-col gap-4 md:gap-5 xl:grid xl:grid-cols-[minmax(0,1fr)_23rem] xl:gap-x-6 xl:gap-y-5">
      <div className="xl:col-span-2">{band}</div>
      <div className="order-2 xl:order-none xl:col-span-2">
        <QuickActions actions={actions} />
      </div>
      <div className="order-3 xl:order-none xl:col-span-2">
        <KpiRow kpis={kpis} />
      </div>

      <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
        {upcomingSection && <div className="order-4 min-w-0 xl:order-none">{upcomingSection}</div>}
        <div className="order-5 min-w-0 xl:order-none">{notYetSection}</div>
        {moneyFirst && <div className="order-6 min-w-0 xl:order-none">{moneyFirst}</div>}
        {moneyRest}
        {tabletParts.length > 0 && (
          <FoldButton
            open={more}
            onToggle={toggle}
            controls={[panels.length > 1 && otherMoneyId, ...detailIds].filter(Boolean).join(' ')}
            parts={tabletParts}
            className="order-9 hidden md:flex xl:hidden"
          />
        )}
      </div>

      <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
        <div className="order-1 min-w-0 xl:order-none">
          <NeedsActionCard needs={needs} error={feedQ.isError} onRetry={() => feedQ.refetch()} />
        </div>
        <FoldButton
          open={more}
          onToggle={toggle}
          controls={[panels.length > 1 && otherMoneyId, calendarFoldId, ...detailIds]
            .filter(Boolean)
            .join(' ')}
          parts={phoneParts}
          className="order-7 flex md:hidden"
        />
        <div
          id={calendarFoldId}
          className={`order-8 grid min-w-0 grid-cols-1 items-start gap-4 md:grid-cols-2 md:gap-5 xl:order-none xl:grid-cols-1 ${more ? '' : 'max-md:hidden'}`}
        >
          {monthCard}
          {activityCard}
        </div>
        {showDetail && (
          <div
            id={detailFoldId}
            className={`order-10 min-w-0 xl:order-none ${more ? '' : 'max-xl:hidden'}`}
          >
            {salesCard}
          </div>
        )}
      </div>

      {/* The table takes the page's full width on a wide screen: seven columns need it. */}
      {marketsCard && (
        <div
          id={marketsFoldId}
          className={`order-11 min-w-0 xl:order-none xl:col-span-2 ${more ? '' : 'max-xl:hidden'}`}
        >
          {marketsCard}
        </div>
      )}
    </div>
  );
}

/**
 * The page's shape while its first reads are out: the welcome, the actions, the figures and the
 * events, at each width's own size, so the real page lands where the skeleton stood.
 */
function OverviewSkeleton({ financials }: { financials: boolean }) {
  return (
    <div
      className="space-y-4 md:space-y-5"
      role="status"
      aria-busy="true"
      aria-label="Loading your overview"
    >
      <Skeleton className="h-[5.5rem] w-full rounded-lg sm:h-[5.25rem]" />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
        {Array.from({ length: financials ? 4 : 2 }).map((_, i) => (
          <Skeleton key={i} className="h-[3.5rem] w-full rounded-lg md:h-[4.5rem]" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5 md:gap-3 xl:grid-cols-4">
        {Array.from({ length: financials ? 4 : 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[8.5rem] w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-52 w-full rounded-lg md:h-40" />
    </div>
  );
}
