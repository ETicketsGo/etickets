'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  MARKETS,
  MetricCard,
  PageHeader,
  Skeleton,
  StatusBadge,
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

// ─────────────────────────── Shared helpers ───────────────────────────

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);

/*
  ── TEN EQUAL BUTTONS ARE NOT A MENU ─────────────────────────────────────────────────
  Every report was a button in one undifferentiated row, so finding "who owes us money" meant
  reading all ten. They are three different jobs - what was sold, what is owed, and how the
  platform is doing - and the strip now says so.

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
const TAB_GROUPS = ['Sales', 'Money owed', 'Platform health'] as const;

function BarRow({
  label,
  value,
  max,
  display,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 truncate text-text-muted" title={label}>
        {label}
      </span>
      <div className="h-2.5 flex-1 rounded-full bg-background-subtle" aria-hidden>
        <div className="h-full rounded-full bg-action-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-32 shrink-0 text-right font-medium tabular-nums text-text-primary">
        {display}
      </span>
    </div>
  );
}

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
  children: (data: T) => React.ReactNode;
}) {
  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError)
    return <ErrorState message="We couldn't load this report." onRetry={() => query.refetch()} />;
  if (!query.data) return null;
  if (isEmpty?.(query.data))
    return <EmptyState title="No data for this range" hint="Try widening the date range." />;
  return <>{children(query.data)}</>;
}

// ─────────────────────────── Sections ───────────────────────────

/**
 * One heading per currency, so nothing on this page is ever two units added together.
 *
 * The report used to be a single set of totals and one chart. That is correct for a platform
 * with one market and arithmetic on incompatible units for a platform with two — a ₹799 sale
 * and a $20 sale came back as 81,900 of something, drawn on one axis with one symbol.
 *
 * A single-currency platform renders exactly one block and reads as it always did.
 */
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
    <h3 className="text-caption font-semibold uppercase tracking-wide text-text-muted">
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
          {!row.configured && <Badge tone="warning">Not a configured market</Badge>}
          <Badge tone="neutral">{row.currency}</Badge>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Gross ticket sales"
          value={money(row.grossMinor, row.currency)}
          tone="success"
        />
        <MetricCard
          label="Platform fees"
          value={money(row.platformFeesMinor, row.currency)}
          tone="info"
        />
        <MetricCard
          label="Refunds"
          value={money(row.refundsMinor, row.currency)}
          tone={row.refundsMinor > 0 ? 'warning' : 'neutral'}
        />
        <MetricCard label="Net" value={money(row.netMinor, row.currency)} />
      </div>
      <p className="mt-4 text-caption text-text-muted">
        {row.bookings} booking{row.bookings === 1 ? '' : 's'} · {row.organizers} organizer
        {row.organizers === 1 ? '' : 's'} · {row.events} event{row.events === 1 ? '' : 's'}
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
              <p className="text-sm text-text-secondary">
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
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                    >
                      <span className="font-medium text-text-primary">{m.country}</span>
                      <span className="text-caption text-text-muted">
                        {m.currency} · nothing sold
                      </span>
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
            /* Scaled within its own currency — a shared axis would compare paise to cents. */
            const maxGross = Math.max(1, ...c.series.map((s) => s.grossMinor));
            return (
              <div key={c.currency} className="space-y-5">
                <CurrencyHeading currency={c.currency} />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <MetricCard
                    label="Gross ticket sales"
                    value={money(c.totals.grossMinor, c.currency)}
                    tone="success"
                  />
                  <MetricCard
                    label="Platform fees"
                    value={money(c.totals.platformFeesMinor, c.currency)}
                    tone="info"
                  />
                  <MetricCard
                    label="Refunds"
                    value={money(c.totals.refundsMinor, c.currency)}
                    tone={c.totals.refundsMinor > 0 ? 'warning' : 'neutral'}
                  />
                  <MetricCard label="Net GMV" value={money(c.totals.netMinor, c.currency)} />
                </div>
                <Card
                  title={`Gross by day - ${currencyLabel(c.currency)}`}
                  action={<ExportCsvButton report="daily-revenue" params={range} />}
                >
                  <div className="space-y-2.5">
                    {c.series.map((s) => (
                      <BarRow
                        key={s.day}
                        label={s.day}
                        value={s.grossMinor}
                        max={maxGross}
                        display={money(s.grossMinor, c.currency)}
                      />
                    ))}
                  </div>
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
  const columns: Column<OrganizerRevenueRow>[] = [
    { key: 'org', header: 'Organizer', render: (o) => o.organizationName },
    /*
      The currency is a column, not a footnote. An organization trading in two markets appears
      once per market, and sorting "Gross" across the table would otherwise rank by whichever
      currency has the smaller minor unit.
    */
    { key: 'currency', header: 'Currency', render: (o) => o.currency },
    {
      key: 'gross',
      header: 'Gross',
      render: (o) => money(o.grossMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.grossMinor,
    },
    {
      key: 'fees',
      header: 'Platform fees',
      render: (o) => money(o.platformFeesMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.platformFeesMinor,
    },
    {
      key: 'refunds',
      header: 'Refunds',
      render: (o) => money(o.refundsMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.refundsMinor,
    },
    {
      key: 'net',
      header: 'Net',
      render: (o) => <span className="font-semibold">{money(o.netMinor, o.currency)}</span>,
      sortable: true,
      sortValue: (o) => o.netMinor,
    },
    {
      key: 'bookings',
      header: 'Bookings',
      render: (o) => o.bookings,
      sortable: true,
      sortValue: (o) => o.bookings,
    },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.organizers.length === 0}>
      {(d) => (
        <div className="space-y-4">
          <div className="flex justify-end">
            <ExportCsvButton report="organizer-revenue" params={{ ...range, limit: 50 }} />
          </div>
          <DataTable columns={columns} rows={d.organizers} rowKey={(o) => o.organizationId} />
        </div>
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
      render: (o) => (
        <span className="font-semibold text-status-warning">
          {money(o.outstandingMinor, o.currency)}
        </span>
      ),
      sortable: true,
      sortValue: (o) => o.outstandingMinor,
    },
    { key: 'oc', header: 'Open payouts', render: (o) => o.outstandingCount },
    {
      key: 'paid',
      header: 'Paid',
      render: (o) => money(o.paidMinor, o.currency),
      sortable: true,
      sortValue: (o) => o.paidMinor,
    },
    { key: 'pc', header: 'Settled payouts', render: (o) => o.paidCount },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.byCurrency.length === 0}>
      {(d) => (
        <div className="space-y-8">
          {d.byCurrency.map((c) => (
            <div key={c.currency} className="space-y-5">
              <CurrencyHeading currency={c.currency} />
              <div className="grid gap-4 sm:grid-cols-3">
                <MetricCard
                  label="Outstanding (unpaid)"
                  value={money(c.totals.outstandingMinor, c.currency)}
                  tone={c.totals.outstandingMinor > 0 ? 'warning' : 'neutral'}
                />
                <MetricCard
                  label="Paid out"
                  value={money(c.totals.paidMinor, c.currency)}
                  tone="success"
                />
                <MetricCard label="Total payouts" value={c.totals.payoutCount} />
              </div>
              <Card
                title={`Settlement by organizer - ${currencyLabel(c.currency)}`}
                action={<ExportCsvButton report="settlement" />}
              >
                <DataTable columns={columns} rows={c.byOrg} rowKey={(o) => o.organizationId} />
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
            /* Scaled within its own currency — a shared axis would compare paise to cents. */
            const maxDay = Math.max(1, ...c.byDay.map((r) => r.amountMinor));
            return (
              <div key={c.currency} className="space-y-5">
                <CurrencyHeading currency={c.currency} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <MetricCard label="Refunds completed" value={c.totals.count} />
                  <MetricCard
                    label="Refund amount"
                    value={money(c.totals.amountMinor, c.currency)}
                    tone={c.totals.amountMinor > 0 ? 'warning' : 'neutral'}
                  />
                </div>
                <div className="grid gap-5 lg:grid-cols-2">
                  <Card title={`By status - ${c.currency}`}>
                    {c.byStatus.length === 0 ? (
                      <EmptyState title="No refunds in this range" />
                    ) : (
                      <ul className="divide-y divide-border text-sm">
                        {c.byStatus.map((s) => (
                          <li key={s.status} className="flex items-center justify-between py-2.5">
                            <StatusBadge status={s.status} />
                            <span className="text-text-muted">
                              {s.count} · {money(s.amountMinor, c.currency)}
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
                    {c.byDay.length === 0 ? (
                      <EmptyState title="No completed refunds" />
                    ) : (
                      <div className="space-y-2.5">
                        {c.byDay.map((r) => (
                          <BarRow
                            key={r.day}
                            label={r.day}
                            value={r.amountMinor}
                            max={maxDay}
                            display={money(r.amountMinor, c.currency)}
                          />
                        ))}
                      </div>
                    )}
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
            const maxDay = Math.max(1, ...c.series.map((s) => s.feesMinor));
            return (
              <div key={c.currency} className="space-y-5">
                <CurrencyHeading currency={c.currency} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <MetricCard
                    label="Platform fee revenue"
                    value={money(c.totals.platformFeesMinor, c.currency)}
                    tone="info"
                  />
                </div>
                <Card title={`Fees by day - ${c.currency}`}>
                  <div className="space-y-2.5">
                    {c.series.map((s) => (
                      <BarRow
                        key={s.day}
                        label={s.day}
                        value={s.feesMinor}
                        max={maxDay}
                        display={money(s.feesMinor, c.currency)}
                      />
                    ))}
                  </div>
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
        <div className="space-y-5">
          <div
            role="note"
            className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-4 text-sm text-text-secondary"
          >
            <p className="font-semibold text-status-warning">
              {d.taxModelled ? 'Tax as charged' : 'Tax is not modelled'}
            </p>
            <p className="mt-1">{d.note}</p>
          </div>
          {/* One block per currency: GST in rupees and sales tax in dollars are two figures. */}
          {d.byCurrency.map((c) => (
            <div key={c.currency} className="space-y-3">
              <CurrencyHeading currency={c.currency} />
              <div className="grid gap-4 sm:grid-cols-3">
                <MetricCard label="Gross ticket sales" value={money(c.grossMinor, c.currency)} />
                <MetricCard label="Platform fees" value={money(c.platformFeesMinor, c.currency)} />
                <MetricCard
                  label="Taxable base"
                  value={money(c.taxableBaseMinor, c.currency)}
                  tone="info"
                />
                <MetricCard
                  label="Tax collected"
                  value={money(c.taxCollectedMinor, c.currency)}
                  tone="neutral"
                />
              </div>
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
        <div>
          <span className="font-medium text-text-primary">{e.movieTitle ?? e.title}</span>
          <span className="ml-2 text-caption text-text-muted">{titleCase(e.experienceType)}</span>
        </div>
      ),
    },
    {
      key: 'bookings',
      header: 'Bookings',
      render: (e) => e.bookings,
      sortable: true,
      sortValue: (e) => e.bookings,
    },
    // The currency sits beside the gross it qualifies, as in Organizer Revenue.
    { key: 'currency', header: 'Currency', render: (e) => e.currency },
    {
      key: 'gross',
      header: 'Gross',
      render: (e) => money(e.grossMinor, e.currency),
      sortable: true,
      sortValue: (e) => e.grossMinor,
    },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.experiences.length === 0}>
      {(d) => (
        <DataTable
          columns={columns}
          rows={d.experiences}
          rowKey={(e) => `${e.eventId}:${e.currency}`}
        />
      )}
    </Section>
  );
}

function GrowthSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'growth', range],
    queryFn: () => api.admin.reports.growth(range),
  });
  const maxUsers = Math.max(1, ...(query.data?.newUsers.map((u) => u.count) ?? [1]));
  const maxBookings = Math.max(1, ...(query.data?.newBookings.map((b) => b.count) ?? [1]));
  const maxOrgs = Math.max(1, ...(query.data?.newOrganizers.map((o) => o.count) ?? [1]));
  return (
    <Section query={query}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Repeat-customer rate"
              value={`${d.retention.rate}%`}
              hint={`${d.retention.repeatCustomers} of ${d.retention.totalCustomers}`}
              tone="info"
            />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="New users by day">
              {d.newUsers.length === 0 ? (
                <EmptyState title="No new users in this range" />
              ) : (
                <div className="space-y-2.5">
                  {d.newUsers.map((u) => (
                    <BarRow
                      key={u.day}
                      label={u.day}
                      value={u.count}
                      max={maxUsers}
                      display={String(u.count)}
                    />
                  ))}
                </div>
              )}
            </Card>
            <Card title="New bookings by day">
              {d.newBookings.length === 0 ? (
                <EmptyState title="No new bookings in this range" />
              ) : (
                <div className="space-y-2.5">
                  {d.newBookings.map((b) => (
                    <BarRow
                      key={b.day}
                      label={b.day}
                      value={b.count}
                      max={maxBookings}
                      display={String(b.count)}
                    />
                  ))}
                </div>
              )}
            </Card>
            <Card title="New organizers by day">
              {d.newOrganizers.length === 0 ? (
                <EmptyState title="No new organizers in this range" />
              ) : (
                <div className="space-y-2.5">
                  {d.newOrganizers.map((o) => (
                    <BarRow
                      key={o.day}
                      label={o.day}
                      value={o.count}
                      max={maxOrgs}
                      display={String(o.count)}
                    />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              label="Overall success rate"
              value={d.overallSuccessRate === null ? '—' : `${d.overallSuccessRate}%`}
              tone={
                d.overallSuccessRate !== null && d.overallSuccessRate >= 95
                  ? 'success'
                  : d.overallSuccessRate !== null && d.overallSuccessRate < 85
                    ? 'warning'
                    : 'info'
              }
            />
          </div>
          <Card title="By provider">
            <ul className="divide-y divide-border text-sm">
              {d.providers.map((p) => (
                <li key={p.provider} className="flex items-center justify-between py-2.5">
                  <span className="font-medium text-text-primary">{p.provider}</span>
                  <span className="text-text-muted">
                    {p.successRate === null ? '—' : `${p.successRate}%`} · {p.succeeded} ok ·{' '}
                    {p.failed} failed
                    {p.pending > 0 ? ` · ${p.pending} pending` : ''}
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

export default function AdminReports() {
  const [tab, setTab] = useState<TabKey>('by-market');
  const [draftFrom, setDraftFrom] = useState(isoDaysAgo(30));
  const [draftTo, setDraftTo] = useState(TODAY);
  const [range, setRange] = useState<ReportRange>({ from: isoDaysAgo(30), to: TODAY });

  const rangeApplies = tab !== 'settlement';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business reports"
        description="Read-only operations reporting across the marketplace."
      />

      {rangeApplies && (
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

      <div
        className="flex flex-wrap gap-x-6 gap-y-3 border-b border-border pb-3"
        role="tablist"
        aria-label="Report sections"
      >
        {TAB_GROUPS.map((groupName) => (
          <div key={groupName} className="space-y-1.5">
            <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
              {groupName}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TABS.filter((t) => t.group === groupName).map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    tab === t.key
                      ? 'bg-action-primary text-action-primary-foreground'
                      : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

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
    </div>
  );
}
