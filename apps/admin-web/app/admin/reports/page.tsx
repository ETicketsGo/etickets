'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  MetricCard,
  PageHeader,
  Skeleton,
  StatusBadge,
  money,
  titleCase,
  useToast,
  errorMessage,
  type Column,
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

const TABS = [
  { key: 'daily-revenue', label: 'Daily Revenue' },
  { key: 'organizer-revenue', label: 'Organizer Revenue' },
  { key: 'settlement', label: 'Settlement' },
  { key: 'refunds', label: 'Refund Report' },
  { key: 'platform-fees', label: 'Platform Fees' },
  { key: 'tax', label: 'Tax' },
  { key: 'top-experiences', label: 'Top Experiences' },
  { key: 'growth', label: 'Growth & Retention' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

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

function DailyRevenueSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'daily-revenue', range],
    queryFn: () => api.admin.reports.dailyRevenue(range),
  });
  const maxGross = Math.max(1, ...(query.data?.series.map((s) => s.grossMinor) ?? [1]));
  return (
    <Section query={query} isEmpty={(d) => d.series.length === 0}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Gross ticket sales"
              value={money(d.totals.grossMinor)}
              tone="success"
            />
            <MetricCard
              label="Platform fees"
              value={money(d.totals.platformFeesMinor)}
              tone="info"
            />
            <MetricCard
              label="Refunds"
              value={money(d.totals.refundsMinor)}
              tone={d.totals.refundsMinor > 0 ? 'warning' : 'neutral'}
            />
            <MetricCard label="Net GMV" value={money(d.totals.netMinor)} />
          </div>
          <Card
            title="Gross by day"
            action={<ExportCsvButton report="daily-revenue" params={range} />}
          >
            <div className="space-y-2.5">
              {d.series.map((s) => (
                <BarRow
                  key={s.day}
                  label={s.day}
                  value={s.grossMinor}
                  max={maxGross}
                  display={money(s.grossMinor)}
                />
              ))}
            </div>
          </Card>
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
    {
      key: 'gross',
      header: 'Gross',
      render: (o) => money(o.grossMinor),
      sortable: true,
      sortValue: (o) => o.grossMinor,
    },
    {
      key: 'fees',
      header: 'Platform fees',
      render: (o) => money(o.platformFeesMinor),
      sortable: true,
      sortValue: (o) => o.platformFeesMinor,
    },
    {
      key: 'refunds',
      header: 'Refunds',
      render: (o) => money(o.refundsMinor),
      sortable: true,
      sortValue: (o) => o.refundsMinor,
    },
    {
      key: 'net',
      header: 'Net',
      render: (o) => <span className="font-semibold">{money(o.netMinor)}</span>,
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
  const columns: Column<SettlementOrgRow>[] = [
    { key: 'org', header: 'Organizer', render: (o) => o.organizationName },
    {
      key: 'outstanding',
      header: 'Outstanding',
      render: (o) => (
        <span className="font-semibold text-status-warning">{money(o.outstandingMinor)}</span>
      ),
      sortable: true,
      sortValue: (o) => o.outstandingMinor,
    },
    { key: 'oc', header: 'Open payouts', render: (o) => o.outstandingCount },
    {
      key: 'paid',
      header: 'Paid',
      render: (o) => money(o.paidMinor),
      sortable: true,
      sortValue: (o) => o.paidMinor,
    },
    { key: 'pc', header: 'Settled payouts', render: (o) => o.paidCount },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.byOrg.length === 0}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Outstanding (unpaid)"
              value={money(d.totals.outstandingMinor)}
              tone={d.totals.outstandingMinor > 0 ? 'warning' : 'neutral'}
            />
            <MetricCard label="Paid out" value={money(d.totals.paidMinor)} tone="success" />
            <MetricCard label="Total payouts" value={d.totals.payoutCount} />
          </div>
          <Card title="Settlement by organizer" action={<ExportCsvButton report="settlement" />}>
            <DataTable columns={columns} rows={d.byOrg} rowKey={(o) => o.organizationId} />
          </Card>
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
  const maxDay = Math.max(1, ...(query.data?.byDay.map((d) => d.amountMinor) ?? [1]));
  return (
    <Section query={query}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard label="Refunds completed" value={d.totals.count} />
            <MetricCard
              label="Refund amount"
              value={money(d.totals.amountMinor)}
              tone={d.totals.amountMinor > 0 ? 'warning' : 'neutral'}
            />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="By status">
              {d.byStatus.length === 0 ? (
                <EmptyState title="No refunds in this range" />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {d.byStatus.map((s) => (
                    <li key={s.status} className="flex items-center justify-between py-2.5">
                      <StatusBadge status={s.status} />
                      <span className="text-text-muted">
                        {s.count} · {money(s.amountMinor)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card
              title="Completed by day"
              action={<ExportCsvButton report="refunds" params={range} />}
            >
              {d.byDay.length === 0 ? (
                <EmptyState title="No completed refunds" />
              ) : (
                <div className="space-y-2.5">
                  {d.byDay.map((r) => (
                    <BarRow
                      key={r.day}
                      label={r.day}
                      value={r.amountMinor}
                      max={maxDay}
                      display={money(r.amountMinor)}
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

function PlatformFeesSection({ range }: { range: ReportRange }) {
  const query = useQuery({
    queryKey: ['admin', 'reports', 'platform-fees', range],
    queryFn: () => api.admin.reports.platformFees(range),
  });
  const maxDay = Math.max(1, ...(query.data?.series.map((s) => s.feesMinor) ?? [1]));
  return (
    <Section query={query} isEmpty={(d) => d.series.length === 0}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              label="Platform fee revenue"
              value={money(d.totals.platformFeesMinor)}
              tone="info"
            />
          </div>
          <Card title="Fees by day">
            <div className="space-y-2.5">
              {d.series.map((s) => (
                <BarRow
                  key={s.day}
                  label={s.day}
                  value={s.feesMinor}
                  max={maxDay}
                  display={money(s.feesMinor)}
                />
              ))}
            </div>
          </Card>
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
            <p className="font-semibold text-status-warning">Tax is not modelled</p>
            <p className="mt-1">{d.note}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Gross ticket sales" value={money(d.grossMinor)} />
            <MetricCard label="Platform fees" value={money(d.platformFeesMinor)} />
            <MetricCard label="Taxable base" value={money(d.taxableBaseMinor)} tone="info" />
            <MetricCard label="Tax collected" value={money(d.taxCollectedMinor)} tone="neutral" />
          </div>
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
    {
      key: 'gross',
      header: 'Gross',
      render: (e) => money(e.grossMinor),
      sortable: true,
      sortValue: (e) => e.grossMinor,
    },
  ];
  return (
    <Section query={query} isEmpty={(d) => d.experiences.length === 0}>
      {(d) => <DataTable columns={columns} rows={d.experiences} rowKey={(e) => e.eventId} />}
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
          </div>
        </div>
      )}
    </Section>
  );
}

// ─────────────────────────── Page ───────────────────────────

export default function AdminReports() {
  const [tab, setTab] = useState<TabKey>('daily-revenue');
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
        className="flex flex-wrap gap-1.5 border-b border-border pb-2"
        role="tablist"
        aria-label="Report sections"
      >
        {TABS.map((t) => (
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

      {tab === 'daily-revenue' && <DailyRevenueSection range={range} />}
      {tab === 'organizer-revenue' && <OrganizerRevenueSection range={range} />}
      {tab === 'settlement' && <SettlementSection />}
      {tab === 'refunds' && <RefundsSection range={range} />}
      {tab === 'platform-fees' && <PlatformFeesSection range={range} />}
      {tab === 'tax' && <TaxSection range={range} />}
      {tab === 'top-experiences' && <TopExperiencesSection range={range} />}
      {tab === 'growth' && <GrowthSection range={range} />}
    </div>
  );
}
