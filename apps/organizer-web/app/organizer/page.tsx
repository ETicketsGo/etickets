'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
import { WelcomeCard } from '@/components/onboarding-checklist';
import { isForbidden } from '@/lib/org-permissions';

export default function OrganizerDashboard() {
  const { activeOrg, can } = useOrg();

  const eventsQ = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });
  /*
    Payouts are financial data and the API refuses them to check-in staff — but this is
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
  // Single aggregate call for the whole organization — replaces the previous
  // per-event `useQueries` fan-out over `GET /reports/event/:id` (N+1).
  const analyticsQ = useQuery({
    queryKey: ['analytics', 'organizer', activeOrg.id],
    queryFn: () => api.analytics.organizer(activeOrg.id),
  });

  const events = eventsQ.data ?? [];
  const analytics = analyticsQ.data;
  const loading = eventsQ.isLoading || analyticsQ.isLoading;
  const isError = eventsQ.isError || analyticsQ.isError;
  const refetchAll = () => {
    eventsQ.refetch();
    analyticsQ.refetch();
  };

  /*
    ── MONEY IS PER MARKET, AND THE ORGANIZER PICKS WHICH ONE ────────────────────────
    These cards used to read a single revenue figure summed across every booking the
    organization had ever taken. For an organizer selling in one country that is right; for
    one selling in two it added rupees to dollars and printed the result with one symbol.

    There is no honest combined total to show instead — this platform has no exchange-rate
    source — so the dashboard shows ONE market at a time and says which. An organizer with a
    single market never sees the switch and reads exactly what they read before.
  */
  const revenues = analytics?.revenue ?? [];
  const countries = analytics?.countries ?? [];
  const [market, setMarket] = useState<string | null>(null);
  const activeCurrency = market ?? revenues[0]?.currency ?? null;
  const revenue = revenues.find((r) => r.currency === activeCurrency);
  const refundsFor = analytics?.refunds?.find((r) => r.currency === activeCurrency);
  const couponsFor = analytics?.coupons?.find((c) => c.currency === activeCurrency);
  /** Countries feeding the selected currency — usually one, and named so it can be read. */
  const marketCountries = countries.filter((c) => c.currency === activeCurrency);

  const sum = {
    gross: revenue?.grossMinor ?? 0,
    net: revenue?.netMinor ?? 0,
    fees: revenue?.bookingFeesMinor ?? 0,
    refunds: refundsFor?.amountMinor ?? 0,
    sold: analytics?.attendance.issued ?? 0,
    checkins: analytics?.attendance.checkedIn ?? 0,
  };
  const checkinRate = analytics?.attendance.checkInRate ?? 0;
  const latestPayout = payoutsQ.data?.[0];

  const mostPopular = analytics?.topTicketType ?? null;
  const publishedCount = events.filter((e) => e.status === 'PUBLISHED').length;
  const capacity = analytics?.capacity;
  const conversion = analytics?.conversion;
  const repeat = analytics?.repeatVisitors;
  const coupons = couponsFor;
  const refundRate = refundsFor?.refundRate ?? 0;
  /* Ranked within the selected market: a top-5 across currencies ranks by exchange accident. */
  const topEvents = (analytics?.topEvents ?? [])
    .filter((e) => e.currency === activeCurrency)
    .slice(0, 5);

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

      <WelcomeCard orgId={activeOrg.id} orgName={activeOrg.name} />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-caption font-semibold uppercase tracking-wide text-text-muted">
                Revenue
                {marketCountries.length > 0 && (
                  <span className="ml-2 font-normal normal-case tracking-normal text-text-secondary">
                    {marketCountries.map((c) => c.country).join(', ')}
                  </span>
                )}
              </h2>
              {/*
                Shown only when there IS a choice. A single-market organizer is not asked to
                make a decision that has one answer.
              */}
              {revenues.length > 1 && (
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Market">
                  {revenues.map((r) => {
                    const label =
                      countries.find((c) => c.currency === r.currency)?.country ?? r.currency;
                    const on = r.currency === activeCurrency;
                    return (
                      <button
                        key={r.currency}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => setMarket(r.currency)}
                        className={`rounded-md border px-3 py-1.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                          on
                            ? 'border-action-primary bg-tint-primary text-action-primary'
                            : 'border-border text-text-secondary hover:bg-background-subtle'
                        }`}
                      >
                        {label} · {r.currency}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Gross sales"
                value={money(sum.gross, activeCurrency ?? undefined)}
                tone="success"
              />
              <MetricCard
                label="Net revenue"
                value={money(sum.net, activeCurrency ?? undefined)}
                tone="info"
              />
              <MetricCard
                label="Booking fees"
                value={money(sum.fees, activeCurrency ?? undefined)}
              />
              <MetricCard
                label="Refunds"
                value={money(sum.refunds, activeCurrency ?? undefined)}
                hint={`${refundRate}% of gross`}
                tone={sum.refunds > 0 ? 'warning' : 'neutral'}
              />
            </div>
          </div>
          <div>
            <h2 className="mb-3 text-caption font-semibold uppercase tracking-wide text-text-muted">
              Sales &amp; attendance
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="Tickets sold" value={sum.sold} />
              <MetricCard
                label="Capacity used"
                value={`${capacity?.utilization ?? 0}%`}
                hint={capacity ? `${capacity.sold} of ${capacity.capacity}` : '—'}
                tone={
                  (capacity?.utilization ?? 0) >= 90
                    ? 'warning'
                    : (capacity?.utilization ?? 0) >= 50
                      ? 'success'
                      : 'neutral'
                }
              />
              <MetricCard
                label="Conversion"
                value={`${conversion?.rate ?? 0}%`}
                hint={conversion ? `${conversion.confirmed} of ${conversion.total} bookings` : '—'}
              />
              <MetricCard
                label="Check-in rate"
                value={`${checkinRate}%`}
                hint={`${sum.checkins} of ${sum.sold} checked in`}
              />
            </div>
          </div>
          <div>
            <h2 className="mb-3 text-caption font-semibold uppercase tracking-wide text-text-muted">
              Engagement
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Repeat customers"
                value={`${repeat?.rate ?? 0}%`}
                hint={repeat ? `${repeat.repeatCustomers} of ${repeat.totalCustomers}` : '—'}
              />
              <MetricCard
                label="Coupons redeemed"
                value={coupons?.redemptions ?? 0}
                hint={
                  coupons
                    ? `${money(coupons.discountMinor, activeCurrency ?? undefined)} discounted`
                    : '—'
                }
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
          </div>
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
          {topEvents.length > 0 && (
            <Card title="Top-performing events">
              <ol className="space-y-2.5">
                {topEvents.map((e, i) => (
                  <li key={e.eventId} className="flex items-center justify-between gap-3">
                    <Link
                      href={`/organizer/events/${e.eventId}`}
                      className="flex min-w-0 items-center gap-2.5"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-tint-primary text-caption font-semibold text-action-primary">
                        {i + 1}
                      </span>
                      <span className="truncate text-[0.9375rem] font-medium text-text-primary hover:text-action-primary">
                        {e.title}
                      </span>
                    </Link>
                    <span className="shrink-0 text-caption font-semibold text-text-secondary">
                      {money(e.grossMinor, e.currency)}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <Card title="Quick actions">
            <div className="space-y-2">
              <ButtonLink href="/organizer/events/new" className="w-full">
                Create event
              </ButtonLink>
              <ButtonLink href="/organizer/events" variant="outline" className="w-full">
                Manage events
              </ButtonLink>
              {showPayouts && (
                <ButtonLink href="/organizer/payouts" variant="outline" className="w-full">
                  View payouts
                </ButtonLink>
              )}
              <p className="pt-1 text-center text-caption text-text-muted">
                Export &amp; message attendees from an event’s Attendees tab.
              </p>
            </div>
          </Card>

          {showPayouts && (
            <Card title="Latest payout">
              {payoutsQ.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : payoutsQ.isError ? (
                <ErrorState
                  message="We couldn't load payouts. Please try again."
                  onRetry={() => payoutsQ.refetch()}
                />
              ) : latestPayout ? (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Status</span>
                    <StatusBadge status={latestPayout.status} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Net amount</span>
                    <span className="font-semibold text-text-primary">
                      {money(latestPayout.netMinor, latestPayout.currency)}
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
          )}
        </div>
      </div>
    </div>
  );
}
