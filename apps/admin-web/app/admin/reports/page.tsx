'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  Activity,
  Banknote,
  CheckCircle2,
  Clock,
  Landmark,
  Percent,
  Receipt,
  Repeat,
  Ticket,
  Undo2,
  Wallet,
} from 'lucide-react';
import {
  api,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  MARKETS,
  PageHeader,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatusPill,
  TabPanel,
  Tabs,
  money,
  titleCase,
  useToast,
  errorMessage,
  type Column,
  type MarketRevenueRow,
  type ReportCsvName,
  type ReportRange,
  type OrganizerRevenueRow,
  type SettlementOrgRow,
  type TopExperienceRow,
} from '@eticketsgo/web-kit';
import { DayColumns } from '../../../components/day-columns';
import { MoneyStatusPill } from '../../../components/money-status';
import { fillDays } from '../../../lib/day-series';

// ─────────────────────────── Shared helpers ───────────────────────────

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);

/*
  ── TEN EQUAL BUTTONS ARE NOT A MENU ─────────────────────────────────────────────────
  Every report was a button in one undifferentiated row, so finding "who owes us money" meant
  reading all ten. They are three different jobs - what was sold, what is owed, and how the
  platform is doing - and each tab now says which job it belongs to in its panel heading.

  "By market" comes first and opens by default. It is the question somebody arrives with, and
  it is the one the page used to answer only by implication: a single INR block, with no way to
  tell a platform that sells nowhere else from a report that had dropped the other markets.
*/
const TABS = [
  { key: 'by-market', label: 'By market', group: 'Sales' },
  { key: 'daily-revenue', label: 'Day by day', group: 'Sales' },
  { key: 'organizer-revenue', label: 'By organizer', group: 'Sales' },
  { key: 'top-experiences', label: 'Top experiences', group: 'Sales' },
  { key: 'settlement', label: 'Settlement', group: 'Money owed' },
  { key: 'refunds', label: 'Refunds', group: 'Money owed' },
  { key: 'platform-fees', label: 'Platform fees', group: 'Money owed' },
  { key: 'tax', label: 'Tax', group: 'Money owed' },
  { key: 'growth', label: 'Growth', group: 'Platform health' },
  { key: 'payment-health', label: 'Payments', group: 'Platform health' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/*
  The quick windows the reports API supports: any from/to of whole days. "Custom" opens the two
  date fields; a preset applies at once, because choosing it IS the decision.
*/
const PRESETS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'custom', label: 'Custom' },
] as const;
type Preset = (typeof PRESETS)[number]['value'];

function ExportCsvButton({
  report,
  params,
}: {
  report: ReportCsvName;
  params?: ReportRange & { limit?: number };
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0 whitespace-nowrap"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.admin.reports.downloadCsv(report, params);
        } catch (e) {
          toast.push(errorMessage(e), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      Export CSV
    </Button>
  );
}

/** Wrap a section's query state into loading / error / empty / content. */
function Section<T>({
  query,
  isEmpty,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; data: T | undefined; refetch: () => void };
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading report">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }
  if (query.isError)
    return <ErrorState message="We couldn't load this report." onRetry={() => query.refetch()} />;
  if (!query.data) return null;
  if (isEmpty?.(query.data))
    return (
      <EmptyState
        title="Nothing in this range"
        hint="Nothing was recorded between these dates. Try a longer window."
      />
    );
  return <>{children(query.data)}</>;
}

/** Four figures in a row: two across on a tablet, one on a phone. */
function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const lg = cols === 4 ? 'xl:grid-cols-4' : cols === 3 ? 'lg:grid-cols-3' : '';
  return <div className={`grid gap-4 sm:grid-cols-2 ${lg}`}>{children}</div>;
}

/**
 * The four money figures every sales report leads with, in the same words and order everywhere:
 * what was sold, what the platform kept, what went back, and what is left.
 *
 * Every figure is the API's own field for ONE currency. Nothing here is added up in the browser.
 */
function MoneyStats({
  currency,
  grossMinor,
  platformFeesMinor,
  refundsMinor,
  netMinor,
}: {
  currency: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
}) {
  return (
    <StatGrid>
      <StatCard
        label="Gross sales"
        value={money(grossMinor, currency)}
        icon={Ticket}
        tile="blue"
        hint="Ticket value sold"
      />
      <StatCard
        label="Platform fees"
        value={money(platformFeesMinor, currency)}
        icon={Percent}
        tile="purple"
        hint="Booking and payment fees"
      />
      <StatCard
        label="Refunds"
        value={money(refundsMinor, currency)}
        icon={Undo2}
        tile="rose"
        hint="Completed refunds"
      />
      <StatCard
        label="Net"
        value={money(netMinor, currency)}
        icon={Wallet}
        tile="teal"
        hint="Gross sales less refunds"
      />
    </StatGrid>
  );
}

// ─────────────────────────── Sections ───────────────────────────

/**
 * Which countries price in a currency, so a block can say "India" and not only "INR".
 *
 * A currency is not a country. INR is India alone, and USD is the United States today and one
 * of several dollar markets the day a second is configured - so the label is built from the
 * market list rather than assumed, and a shared currency names every country that uses it.
 */
const COUNTRIES_BY_CURRENCY = new Map<string, string[]>();
for (const m of MARKETS) {
  COUNTRIES_BY_CURRENCY.set(m.currency, [...(COUNTRIES_BY_CURRENCY.get(m.currency) ?? []), m.name]);
}
function currencyLabel(currency: string): string {
  const countries = COUNTRIES_BY_CURRENCY.get(currency);
  return countries?.length ? `${countries.join(' / ')} - ${currency}` : currency;
}

/*
  Shown even when there is only ONE block.

  It used to be hidden for a single-currency platform, on the reasoning that a heading over one
  thing says nothing. It says the most important thing: WHICH market these figures are. A page
  of rupee totals with no heading reads as "the platform", and an operator cannot tell it from a
  report that has silently lost every other market.
*/
function CurrencyHeading({ currency }: { currency: string }) {
  return (
    <h3 className="flex items-center gap-2 text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-action-primary" />
      {currencyLabel(currency)}
    </h3>
  );
}

/**
 * One card per country, and a named line for every market that sold nothing.
 *
 * ── WHY CARDS AND NOT A TABLE ──────────────────────────────────────────────────────
 * The figures are gross, fees, refunds, net, bookings, organizers and events - seven columns,
 * which is how the admin console came to scroll sideways everywhere. A market is also not a row
 * somebody scans past: there are a handful of them, and each one is a small report. So each
 * gets a card, and the currency symbol sits on every amount inside it, because two cards on the
 * same screen are in two different currencies.
 */
function MarketCard({ row }: { row: MarketRevenueRow }) {
  return (
    <Card
      title={row.country}
      action={
        <div className="flex items-center gap-2">
          {!row.configured && <StatusPill tone="warning">Not a configured market</StatusPill>}
          <StatusPill tone="neutral" dot={false}>
            {row.currency}
          </StatusPill>
        </div>
      }
    >
      <MoneyStats
        currency={row.currency}
        grossMinor={row.grossMinor}
        platformFeesMinor={row.platformFeesMinor}
        refundsMinor={row.refundsMinor}
        netMinor={row.netMinor}
      />
      <p className="mt-4 text-caption tabular-nums text-text-muted">
        {row.bookings.toLocaleString()} booking{row.bookings === 1 ? '' : 's'} -{' '}
        {row.organizers.toLocaleString()} organizer{row.organizers === 1 ? '' : 's'} -{' '}
        {row.events.toLocaleString()} event{row.events === 1 ? '' : 's'}
      </p>
      {!row.configured && (
        <p className="mt-2 text-caption text-status-warning">
          A venue here holds a country the platform has no currency, payment routing or fee
          configuration for. Check the venue address.
        </p>
      )}
    </Card>
  );
}

function ByMarketSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'by-market', range],
    queryFn: () => api.admin.reports.byMarket(range),
  });
  return (
    <Section query={query}>
      {(d) => {
        const trading = d.markets.filter((m) => m.bookings > 0 || m.refundsMinor > 0);
        const idle = d.markets.filter((m) => m.bookings === 0 && m.refundsMinor === 0);
        return (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-ui text-text-secondary">
                {trading.length === 0
                  ? 'No market sold a ticket in this range.'
                  : `Selling in ${trading.length} of ${MARKETS.length} configured market${
                      MARKETS.length === 1 ? '' : 's'
                    }. Each amount is in that market's own currency - nothing on this page adds two currencies together.`}
              </p>
              <ExportCsvButton report="by-market" params={range} />
            </div>

            {trading.map((m) => (
              <MarketCard key={`${m.country}:${m.currency}`} row={m} />
            ))}

            {idle.length > 0 && (
              <Card title="Configured, with nothing sold in this range">
                {/*
                  The point of the whole section. A market with no sales used to be absent, and an
                  absent market is indistinguishable from a broken report - which is exactly the
                  question that got asked about a page showing only rupees.
                */}
                <ul className="divide-y divide-border">
                  {idle.map((m) => (
                    <li
                      key={`${m.country}:${m.currency}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-ui"
                    >
                      <span className="font-medium text-text-primary">{m.country}</span>
                      <StatusPill tone="neutral" size="sm">
                        {m.currency} - nothing sold
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        );
      }}
    </Section>
  );
}

function DailyRevenueSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'daily-revenue', range],
    queryFn: () => api.admin.reports.dailyRevenue(range),
  });
  return (
    <Section query={query} isEmpty={(d) => d.byCurrency.length === 0}>
      {(d) => (
        <div className="space-y-8">
          {d.byCurrency.map((c) => {
            /* Scaled within its own currency - a shared axis would compare paise to cents. */
            const days = fillDays(
              c.series.map((s) => ({ day: s.day, value: s.grossMinor })),
              d.from ?? range.from,
              d.to ?? range.to,
              (day) => ({ day, value: 0 }),
            );
            return (
              <div key={c.currency} className="space-y-4">
                <CurrencyHeading currency={c.currency} />
                <MoneyStats
                  currency={c.currency}
                  grossMinor={c.totals.grossMinor}
                  platformFeesMinor={c.totals.platformFeesMinor}
                  refundsMinor={c.totals.refundsMinor}
                  netMinor={c.totals.netMinor}
                />
                <Card
                  title={`Gross sales by day - ${currencyLabel(c.currency)}`}
                  action={<ExportCsvButton report="daily-revenue" params={range} />}
                >
                  <DayColumns
                    label={`Gross sales by day in ${c.currency}`}
                    points={days.map((p) => ({ ...p, display: money(p.value, c.currency) }))}
                  />
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function OrganizerRevenueSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'organizer-revenue', range],
    queryFn: () => api.admin.reports.organizerRevenue({ ...range, limit: 50 }),
  });
  /*
    The currency is part of every amount, and also its own line under the organizer. An
    organization trading in two markets appears once per market, and sorting "Gross sales" across
    the table orders rows of one currency meaningfully only - so the currency is never hidden.
  */
  const columns: Column<OrganizerRevenueRow>[] = [
    {
      key: 'org',
      header: 'Organizer',
      render: (o) => (
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-text-primary">{o.organizationName}</p>
          <p className="text-caption text-text-muted">
            {o.currency} - {o.bookings.toLocaleString()} booking{o.bookings === 1 ? '' : 's'}
          </p>
        </div>
      ),
    },
    {
      key: 'gross',
      header: 'Gross sales',
      className: 'whitespace-nowrap tabular-nums',
      render: (o) => money(o.grossMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.grossMinor,
    },
    {
      key: 'fees',
      header: 'Platform fees',
      className: 'whitespace-nowrap tabular-nums',
      render: (o) => money(o.platformFeesMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.platformFeesMinor,
    },
    {
      key: 'refunds',
      header: 'Refunds',
      className: 'whitespace-nowrap tabular-nums',
      render: (o) => money(o.refundsMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.refundsMinor,
    },
    // Not the market report's net: this one also takes off the organizer's own fee, as a payout does.
    {
      key: 'net',
      header: 'Net to organizer',
      className: 'whitespace-nowrap tabular-nums',
      render: (o) => <span className="font-semibold">{money(o.netMinor, o.currency)}</span>,
      sortable: true,
      sortValue: (o) => o.netMinor,
    },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.organizers.length === 0}>
      {(d) => (
        <Card
          title="Sales by organizer"
          action={<ExportCsvButton report="organizer-revenue" params={{ ...range, limit: 50 }} />}
        >
          <DataTable
            caption="Sales by organizer"
            columns={columns}
            rows={d.organizers}
            rowKey={(o) => `${o.organizationId}:${o.currency}`}
            density="compact"
            mobile="cards"
            stickyHeader
          />
        </Card>
      )}
    </Section>
  );
}

function SettlementSection() {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'settlement'],
    queryFn: () => api.admin.reports.settlement(),
  });
  // Every amount in its own currency: payouts are one per currency, and were all printed as rupees.
  const columns: Column<SettlementOrgRow>[] = [
    { key: 'org', header: 'Organizer', render: (o) => o.organizationName },
    {
      key: 'outstanding',
      header: 'Outstanding',
      className: 'whitespace-nowrap tabular-nums',
      render: (o) => (
        <div className="space-y-0.5">
          <p className="font-semibold text-text-primary">{money(o.outstandingMinor, o.currency)}</p>
          <p className="text-caption text-text-muted">
            {o.outstandingCount} open payout{o.outstandingCount === 1 ? '' : 's'}
          </p>
        </div>
      ),
      sortable: true,
      sortValue: (o) => o.outstandingMinor,
    },
    {
      key: 'paid',
      header: 'Paid',
      className: 'whitespace-nowrap tabular-nums',
      render: (o) => (
        <div className="space-y-0.5">
          <p>{money(o.paidMinor, o.currency)}</p>
          <p className="text-caption text-text-muted">
            {o.paidCount} settled payout{o.paidCount === 1 ? '' : 's'}
          </p>
        </div>
      ),
      sortable: true,
      sortValue: (o) => o.paidMinor,
    },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.byCurrency.length === 0}>
      {(d) => (
        <div className="space-y-8">
          {d.byCurrency.map((c) => (
            <div key={c.currency} className="space-y-4">
              <CurrencyHeading currency={c.currency} />
              <StatGrid cols={3}>
                <StatCard
                  label="Outstanding (unpaid)"
                  value={money(c.totals.outstandingMinor, c.currency)}
                  icon={Clock}
                  tile="amber"
                  tone={c.totals.outstandingMinor > 0 ? 'warning' : 'neutral'}
                />
                <StatCard
                  label="Paid out"
                  value={money(c.totals.paidMinor, c.currency)}
                  icon={Banknote}
                  tile="teal"
                />
                <StatCard
                  label="Total payouts"
                  value={c.totals.payoutCount.toLocaleString()}
                  icon={Receipt}
                  tile="blue"
                />
              </StatGrid>
              <Card
                title={`Settlement by organizer - ${currencyLabel(c.currency)}`}
                action={<ExportCsvButton report="settlement" />}
              >
                <DataTable
                  caption={`Settlement by organizer in ${c.currency}`}
                  columns={columns}
                  rows={c.byOrg}
                  rowKey={(o) => o.organizationId}
                  density="compact"
                  mobile="cards"
                />
              </Card>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function RefundsSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'refunds', range],
    queryFn: () => api.admin.reports.refunds(range),
  });
  return (
    <Section query={query} isEmpty={(d) => d.byCurrency.length === 0}>
      {(d) => (
        <div className="space-y-8">
          {d.byCurrency.map((c) => {
            const days = fillDays(
              c.byDay.map((r) => ({ day: r.day, value: r.amountMinor })),
              d.from ?? range.from,
              d.to ?? range.to,
              (day) => ({ day, value: 0 }),
            );
            return (
              <div key={c.currency} className="space-y-4">
                <CurrencyHeading currency={c.currency} />
                <StatGrid cols={2}>
                  <StatCard
                    label="Refunds completed"
                    value={c.totals.count.toLocaleString()}
                    icon={CheckCircle2}
                    tile="teal"
                  />
                  <StatCard
                    label="Refund amount"
                    value={money(c.totals.amountMinor, c.currency)}
                    icon={Undo2}
                    tile="rose"
                  />
                </StatGrid>
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <Card title={`By status - ${c.currency}`}>
                    {c.byStatus.length === 0 ? (
                      <EmptyState title="No refunds in this range" compact />
                    ) : (
                      <ul className="divide-y divide-border text-ui">
                        {c.byStatus.map((s) => (
                          <li
                            key={s.status}
                            className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                          >
                            <MoneyStatusPill entity="refund" status={s.status} />
                            <span className="tabular-nums text-text-secondary">
                              {s.count.toLocaleString()} - {money(s.amountMinor, c.currency)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card
                    title={`Completed by day - ${c.currency}`}
                    action={<ExportCsvButton report="refunds" params={range} />}
                  >
                    <DayColumns
                      label={`Completed refunds by day in ${c.currency}`}
                      points={days.map((p) => ({ ...p, display: money(p.value, c.currency) }))}
                      emptyText="No completed refunds in this range."
                    />
                  </Card>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function PlatformFeesSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'platform-fees', range],
    queryFn: () => api.admin.reports.platformFees(range),
  });
  return (
    <Section query={query} isEmpty={(d) => d.byCurrency.length === 0}>
      {(d) => (
        <div className="space-y-8">
          {d.byCurrency.map((c) => {
            const days = fillDays(
              c.series.map((s) => ({ day: s.day, value: s.feesMinor })),
              d.from ?? range.from,
              d.to ?? range.to,
              (day) => ({ day, value: 0 }),
            );
            return (
              <div key={c.currency} className="space-y-4">
                <CurrencyHeading currency={c.currency} />
                <StatGrid cols={3}>
                  <StatCard
                    label="Platform fee revenue"
                    value={money(c.totals.platformFeesMinor, c.currency)}
                    icon={Percent}
                    tile="purple"
                  />
                </StatGrid>
                <Card title={`Platform fees by day - ${c.currency}`}>
                  <DayColumns
                    label={`Platform fees by day in ${c.currency}`}
                    points={days.map((p) => ({ ...p, display: money(p.value, c.currency) }))}
                  />
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function TaxSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'tax', range],
    queryFn: () => api.admin.reports.tax(range),
  });
  return (
    <Section query={query}>
      {(d) => (
        <div className="space-y-6">
          <div
            role="note"
            className="flex items-start gap-3 rounded-lg border border-border bg-tint-warning p-4 text-ui"
          >
            <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" aria-hidden />
            <div>
              <p className="font-semibold text-status-warning">
                {d.taxModelled ? 'Tax as charged' : 'Tax is not modelled'}
              </p>
              <p className="mt-1 text-text-secondary">{d.note}</p>
            </div>
          </div>
          {/* One block per currency: GST in rupees and sales tax in dollars are two figures. */}
          {d.byCurrency.map((c) => (
            <div key={c.currency} className="space-y-4">
              <CurrencyHeading currency={c.currency} />
              <StatGrid>
                <StatCard
                  label="Gross sales"
                  value={money(c.grossMinor, c.currency)}
                  icon={Ticket}
                  tile="blue"
                />
                <StatCard
                  label="Platform fees"
                  value={money(c.platformFeesMinor, c.currency)}
                  icon={Percent}
                  tile="purple"
                />
                <StatCard
                  label="Taxable base"
                  value={money(c.taxableBaseMinor, c.currency)}
                  icon={Landmark}
                  tile="amber"
                />
                <StatCard
                  label="Tax collected"
                  value={money(c.taxCollectedMinor, c.currency)}
                  icon={Receipt}
                  tile="teal"
                />
              </StatGrid>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function TopExperiencesSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'top-experiences', range],
    queryFn: () => api.admin.reports.topExperiences({ ...range, limit: 20 }),
  });
  const columns: Column<TopExperienceRow>[] = [
    {
      key: 'title',
      header: 'Experience',
      render: (e) => (
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-text-primary">{e.movieTitle ?? e.title}</p>
          <p className="text-caption text-text-muted">{titleCase(e.experienceType)}</p>
        </div>
      ),
    },
    {
      key: 'bookings',
      header: 'Bookings',
      className: 'tabular-nums',
      render: (e) => e.bookings.toLocaleString(),
      sortable: true,
      sortValue: (e) => e.bookings,
    },
    // The currency is in the amount, as in Organizer Revenue: rows in two currencies never add.
    {
      key: 'gross',
      header: 'Gross sales',
      className: 'whitespace-nowrap tabular-nums',
      render: (e) => <span className="font-semibold">{money(e.grossMinor, e.currency)}</span>,
      sortable: true,
      sortValue: (e) => e.grossMinor,
    },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.experiences.length === 0}>
      {(d) => (
        <Card title="Top experiences">
          <DataTable
            caption="Top experiences"
            columns={columns}
            rows={d.experiences}
            rowKey={(e) => `${e.eventId}:${e.currency}`}
            density="compact"
            mobile="cards"
          />
        </Card>
      )}
    </Section>
  );
}

function GrowthSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'growth', range],
    queryFn: () => api.admin.reports.growth(range),
  });
  return (
    <Section query={query}>
      {(d) => {
        const counts = (rows: { day: string; count: number }[]) =>
          fillDays(
            rows.map((r) => ({ day: r.day, value: r.count })),
            d.from ?? range.from,
            d.to ?? range.to,
            (day) => ({ day, value: 0 }),
          ).map((p) => ({ ...p, display: p.value.toLocaleString() }));
        return (
          <div className="space-y-5">
            <StatGrid cols={3}>
              <StatCard
                label="Repeat-customer rate"
                value={`${d.retention.rate}%`}
                hint={`${d.retention.repeatCustomers.toLocaleString()} of ${d.retention.totalCustomers.toLocaleString()} customers`}
                icon={Repeat}
                tile="teal"
              />
            </StatGrid>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="New bookings by day">
                <DayColumns
                  label="New bookings by day"
                  points={counts(d.newBookings)}
                  emptyText="No new bookings in this range."
                />
              </Card>
              <Card title="New users by day">
                <DayColumns
                  label="New users by day"
                  points={counts(d.newUsers)}
                  emptyText="No new users in this range."
                />
              </Card>
              <Card title="New organizers by day">
                <DayColumns
                  label="New organizers by day"
                  points={counts(d.newOrganizers)}
                  emptyText="No new organizers in this range."
                />
              </Card>
            </div>
          </div>
        );
      }}
    </Section>
  );
}

function PaymentHealthSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'payment-health', range],
    queryFn: () => api.admin.reports.paymentHealth(range),
  });
  return (
    <Section query={query} isEmpty={(d) => d.providers.length === 0}>
      {(d) => (
        <div className="space-y-5">
          <StatGrid cols={3}>
            <StatCard
              label="Overall success rate"
              value={d.overallSuccessRate === null ? 'Not enough data' : `${d.overallSuccessRate}%`}
              icon={Activity}
              tile="teal"
              tone={
                d.overallSuccessRate !== null && d.overallSuccessRate >= 95
                  ? 'success'
                  : d.overallSuccessRate !== null && d.overallSuccessRate < 85
                    ? 'warning'
                    : 'neutral'
              }
            />
          </StatGrid>
          <Card title="By provider">
            <ul className="divide-y divide-border text-ui">
              {d.providers.map((p) => (
                <li
                  key={p.provider}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                >
                  <span className="font-medium text-text-primary">{p.provider}</span>
                  <span className="flex flex-wrap items-center gap-2 tabular-nums">
                    <span className="text-text-secondary">
                      {p.successRate === null ? 'No rate yet' : `${p.successRate}% succeeded`}
                    </span>
                    <StatusPill tone="success" size="sm">
                      {p.succeeded.toLocaleString()} paid
                    </StatusPill>
                    <StatusPill tone={p.failed > 0 ? 'error' : 'neutral'} size="sm">
                      {p.failed.toLocaleString()} failed
                    </StatusPill>
                    {p.pending > 0 && (
                      <StatusPill tone="info" size="sm">
                        {p.pending.toLocaleString()} pending
                      </StatusPill>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Section>
  );
}

// ─────────────────────────── Page ───────────────────────────

const TABS_ID = 'business-reports';

export default function AdminReports() {
  const [tab, setTab] = useState<TabKey>('by-market');
  const [preset, setPreset] = useState<Preset>('30');
  const [draftFrom, setDraftFrom] = useState(isoDaysAgo(30));
  const [draftTo, setDraftTo] = useState(TODAY);
  const [range, setRange] = useState<ReportRange>({ from: isoDaysAgo(30), to: TODAY });

  const rangeApplies = tab !== 'settlement';
  const current = TABS.find((t) => t.key === tab)!;

  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (next === 'custom') return;
    const from = isoDaysAgo(Number(next));
    setDraftFrom(from);
    setDraftTo(TODAY);
    setRange({ from, to: TODAY });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business reports"
        description="Read-only operations reporting across the marketplace. Every amount stays in its own currency."
      />

      <Tabs
        id={TABS_ID}
        label="Report sections"
        tabs={TABS.map((t) => ({ value: t.key, label: t.label }))}
        value={tab}
        onChange={setTab}
      />

      <TabPanel tabsId={TABS_ID} value={tab} selected={tab} className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
              {current.group}
            </p>
            <h2 className="font-display text-headline font-bold text-text-primary">
              {current.label}
            </h2>
          </div>
          {rangeApplies ? (
            <SegmentedControl
              label="Date range, counting back from today"
              options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              value={preset}
              onChange={choosePreset}
            />
          ) : (
            <p className="text-caption text-text-muted">
              Settlement is a position today, so it has no date range.
            </p>
          )}
        </div>

        {rangeApplies && preset === 'custom' && (
          <Card>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setRange({ from: draftFrom, to: draftTo });
              }}
            >
              <Input
                id="from"
                label="From"
                type="date"
                value={draftFrom}
                max={draftTo}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="w-auto"
              />
              <Input
                id="to"
                label="To"
                type="date"
                value={draftTo}
                min={draftFrom}
                max={TODAY}
                onChange={(e) => setDraftTo(e.target.value)}
                className="w-auto"
              />
              <Button type="submit" variant="outline">
                Apply range
              </Button>
            </form>
          </Card>
        )}

        {tab === 'by-market' && <ByMarketSection range={range} />}
        {tab === 'daily-revenue' && <DailyRevenueSection range={range} />}
        {tab === 'organizer-revenue' && <OrganizerRevenueSection range={range} />}
        {tab === 'settlement' && <SettlementSection />}
        {tab === 'refunds' && <RefundsSection range={range} />}
        {tab === 'platform-fees' && <PlatformFeesSection range={range} />}
        {tab === 'tax' && <TaxSection range={range} />}
        {tab === 'top-experiences' && <TopExperiencesSection range={range} />}
        {tab === 'growth' && <GrowthSection range={range} />}
        {tab === 'payment-health' && <PaymentHealthSection range={range} />}
      </TabPanel>
    </div>
  );
}
