'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import {
  api,
  brandButtonClasses,
  marketFor,
  useAuthUser,
  type AnalyticsOrganizerMarket,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { isForbidden } from '@/lib/org-permissions';
import type { EventListRow } from '@/components/events/event-list-model';
import { greetingDate, pendingActions, recentActivity } from './_dashboard/model';
import { moneyPanels, needsAction } from './_dashboard/overview-model';
import { sellingOf } from './_dashboard/status';
import {
  comingUpRows,
  comingUpTotal,
  moneyFigures,
  needsContext,
  orgStanding,
  pickNextStep,
} from './_dashboard/desk-model';
import {
  BestSellers,
  ComingUp,
  DeskOverviewError,
  DeskOverviewSkeleton,
  FigureStrip,
  MarketsDisclosure,
  NeedsYou,
  OverviewHeader,
  RecentActivity,
  type FigureCell,
} from './_dashboard/desk';

/** The notification centre's own react-query key, so this reads its cache, not a second copy. */
const FEED_KEY = ['notifications', 'feed', 'organizer'] as const;

const count = (n: number) => n.toLocaleString('en-IN');

/**
 * The organizer's Overview: a desk, not a dashboard of everything.
 *
 * ── FIVE QUESTIONS, IN THIS ORDER ──────────────────────────────────────────────────
 * docs/design/DESIGN-SYSTEM.md and EXPERIENCE-AUDIT.md (O1-O3). The old page opened on a red
 * "Needs action (13)", four quick-action tiles, four stat tiles with two lines of explanation
 * each, a month calendar, a day agenda, activity, sales performance and a market table - when
 * everything is loud nothing is. This page answers only:
 *
 *   1. What is happening with my events?   "Coming up": the next events on sale, then drafts.
 *   2. What needs my attention?            "Needs you": costliest first (blocking, then warnings).
 *   3. How many tickets have I sold?       The Tickets sold figure.
 *   4. Where is my money?                  Gross sales and Payable now, one currency each.
 *   5. What should I do next?              One step: the costliest open item, or the plain next
 *                                          thing when nothing is open (`nextStepWhenClear`).
 *
 * Everything else - the calendar, activity, payouts, receipts, the market split - is one click
 * away: in the sidebar, behind a figure, or (for markets) folded at the foot of the page.
 *
 * ── NO NEW FIGURES ─────────────────────────────────────────────────────────────────
 * Every number is an API field or a count of rows the API returned (`_dashboard/desk-model.ts`,
 * tested). Money is never added across currencies; nothing about the finance model is computed
 * here. The sale-state words are the server's (`sellingOf`), the same sentence every console
 * screen uses.
 */
export default function OrganizerDashboard() {
  const { activeOrg, can } = useOrg();
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
    everybody's landing page, so the read is skipped for a role that cannot make it, and a
    refusal only hides the Payable figure.
  */
  const summaryQ = useQuery({
    queryKey: ['payouts', 'summary', activeOrg.id],
    queryFn: () => api.payouts.summary(activeOrg.id),
    enabled: can.financials,
    retry: (n, error) => !isForbidden(error) && n < 2,
  });
  const ledger = can.financials && !isForbidden(summaryQ.error) ? summaryQ.data : undefined;

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

  const [now] = useState(() => new Date());
  /*
    The date line is the viewer's own "today", which a server cannot know: it formats in the
    server's zone, and the first client render in the viewer's. Two different strings in the same
    place is React error #418 (a hydration mismatch). It is written after mount instead.
  */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const events = useMemo(() => (eventsQ.data ?? []) as EventListRow[], [eventsQ.data]);
  const rows = useMemo(() => comingUpRows(events, now), [events, now]);
  const total = useMemo(() => comingUpTotal(events, now), [events, now]);

  /*
    ── IS IT SELLING: ONE SERVER ANSWER ──────────────────────────────────────────────
    The API's unified sale state per event, judged over ALL its upcoming shows, for the events
    on sale in the table (owners and managers; the endpoint refuses anyone else). This page
    decides nothing about it. A handful of ids, under the cap.
  */
  const askedIds = useMemo(
    () =>
      rows
        .filter((r) => r.kind === 'on-sale')
        .map((r) => r.event.id)
        .sort(),
    [rows],
  );
  const statesQ = useQuery({
    queryKey: ['organizer-event-sale-states', activeOrg.id, askedIds.join(',')],
    queryFn: () => api.events.saleStates(activeOrg.id, askedIds),
    enabled: askedIds.length > 0 && can.financials,
    staleTime: 60_000,
    retry: 1,
  });
  const states = useMemo(
    () => new Map((statesQ.data?.events ?? []).map((e) => [e.eventId, e])),
    [statesQ.data],
  );

  const analytics = analyticsQ.data;
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
  const moneyNow = moneyFigures(panels, ledger);

  const needs = needsAction(actionsQ.data?.actions, pendingActions(feedQ.data));
  const canCreate = can.financials || can.ownerActions;
  const next = pickNextStep({ needs, events, rows, canCreate });
  const firstName = user?.fullName?.trim().split(/\s+/)[0];

  const header = (
    <OverviewHeader
      // "Tuesday 13 October": the viewer's own today, without the year a desk does not need.
      dateLine={
        mounted
          ? greetingDate(now)
              .replace(/ \d{4}$/, '')
              .replace(',', '')
          : ''
      }
      welcome={firstName ? `Welcome back, ${firstName}.` : undefined}
      status={orgStanding(activeOrg.status)}
    />
  );

  if (eventsQ.isError || analyticsQ.isError)
    return (
      <div data-brand="console" className="flex flex-col gap-6">
        {header}
        <DeskOverviewError
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
    page stands in for all of it, so nothing is pushed down as each read lands
    (`overview-layout-stability.spec.ts`). A read the viewer's role does not make is not
    waited for (a disabled query is not loading).
  */
  const booting =
    eventsQ.isLoading ||
    analyticsQ.isLoading ||
    actionsQ.isLoading ||
    feedQ.isLoading ||
    summaryQ.isLoading;
  if (booting)
    return (
      <div data-brand="console">
        <DeskOverviewSkeleton />
      </div>
    );

  const attendance = analytics?.attendance;
  const sellingEvents = events.filter((e) => (e.tickets?.sold ?? 0) > 0).length;
  const cells: FigureCell[] = [
    ...(moneyNow
      ? [
          {
            key: 'gross',
            label: 'Gross sales',
            value: moneyNow.gross.value,
            context: moneyNow.gross.context,
            href: '/organizer/finance',
          },
        ]
      : []),
    {
      key: 'tickets',
      label: 'Tickets sold',
      value: count(attendance?.issued ?? 0),
      context:
        attendance && attendance.checkedIn > 0
          ? `${count(attendance.checkedIn)} checked in so far`
          : sellingEvents > 0
            ? `across ${count(sellingEvents)} ${sellingEvents === 1 ? 'event' : 'events'}`
            : 'None sold yet',
      href: can.financials ? '/organizer/bookings' : undefined,
    },
    ...(moneyNow?.payable
      ? [
          {
            key: 'payable',
            label: 'Payable now',
            value: moneyNow.payable.value,
            context: moneyNow.payable.context,
            href: '/organizer/payouts',
          },
        ]
      : []),
    {
      key: 'needs',
      label: 'Needs you',
      value: count(needs.items.length),
      context: needsContext(needs),
      alert: needs.blocking > 0,
    },
  ];

  const empty = (
    <div className="flex max-w-prose flex-col items-start gap-2">
      <p className="font-brand-display text-brand-d3 text-brand-ink">
        {events.length === 0 ? 'Your first event starts here' : 'Nothing is on sale right now'}
      </p>
      <p className="text-brand-ui text-brand-ink-2">
        {events.length === 0
          ? 'Events you create show here with their dates, how they are selling and what they have earned.'
          : 'Events you publish show here with their next date and how they are selling.'}
      </p>
      {/* The one useful thing to do from an empty list, for the members who can do it. */}
      {canCreate && (
        <Link
          href={events.length === 0 ? '/organizer/events/new' : '/organizer/events'}
          className={`mt-2 ${brandButtonClasses('secondary', 'md')}`}
        >
          {events.length === 0 && <Plus className="h-4 w-4" aria-hidden />}
          {events.length === 0 ? 'Create your first event' : 'Publish an event'}
        </Link>
      )}
    </div>
  );
  const activity = recentActivity(feedQ.data, 5);
  const topEvents = can.financials ? (analytics?.topEvents ?? []).slice(0, 5) : [];

  /*
    ── ONE ORDER FOR EVERY WIDTH ──────────────────────────────────────────────────────
    Phone and laptop: the header, the figures, what needs you (with the next step), then what
    is coming up. From `xl` the events take the main column and Needs you sits beside them, so
    a 1440px screen answers all five questions without a scroll. CSS only: nothing is decided
    after the first paint.
  */
  return (
    <div data-brand="console" className="flex flex-col gap-6 md:gap-8">
      {header}
      <FigureStrip cells={cells} />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-8">
        <div className="order-2 flex min-w-0 flex-col gap-6 xl:order-1">
          <ComingUp
            rows={rows}
            total={total}
            showMoney={can.financials}
            sellingOf={(id) =>
              can.financials ? sellingOf(states.get(id), statesQ.isError) : undefined
            }
            empty={empty}
          />
          {topEvents.length > 0 && <BestSellers events={topEvents} />}
          {can.financials && markets.length > 1 && <MarketsDisclosure markets={markets} />}
        </div>
        <div className="order-1 flex min-w-0 flex-col gap-6 xl:order-2">
          <NeedsYou
            needs={needs}
            next={next}
            failed={feedQ.isError}
            onRetry={() => feedQ.refetch()}
            canAct={canCreate}
            perGroup={2}
          />
          {/* Below `xl` it would sit between Needs you and the events; there it waits its turn. */}
          <div className="hidden xl:block">
            <RecentActivity groups={activity} failed={feedQ.isError} />
          </div>
        </div>
        <div className="order-3 min-w-0 xl:hidden">
          <RecentActivity groups={activity} failed={feedQ.isError} />
        </div>
      </div>
    </div>
  );
}
