'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  dateOnly,
  errorMessage,
  useToast,
  type CrmCsvReport,
  type CrmGroupRow,
  type CrmReportFilters,
} from '@eticketsgo/web-kit';
import { CRM_ACTIVITY_TYPES, CRM_LEAD_SOURCES, CRM_STAGES } from '@eticketsgo/shared-types';
import {
  CrmGate,
  EMPTY_FILTERS,
  Kpi,
  RatioText,
  useCrmMe,
  type CrmFilterState,
} from '../../../../components/crm/crm-ui';
import {
  LOGGED_NOT_SENT,
  activityLabel,
  countryName,
  dayEndExclusiveIso,
  dayStartIso,
  ratioText,
  sourceLabel,
  stageLabel,
} from '../../../../lib/crm';

/**
 * Acquisition reports for managers, all aggregated by the server over the teams they manage.
 *
 * Every share is printed with what it is a share of. "Activated" and "first event" come from
 * the organizer accounts and their events; the stage a person chose is shown beside them.
 * Activity figures count outreach people LOGGED; the platform sent none of it.
 */
export default function ReportsPage() {
  return (
    <CrmGate manager>
      <Reports />
    </CrmGate>
  );
}

function Section({
  title,
  csv,
  filters,
  children,
}: {
  title: string;
  csv?: CrmCsvReport;
  filters: CrmReportFilters;
  children: ReactNode;
}) {
  const toast = useToast();
  return (
    <Card
      title={title}
      action={
        csv && (
          <Button
            size="sm"
            variant="outline"
            icon={Download}
            onClick={() =>
              api.admin.crm.reports
                .downloadCsv(csv, filters)
                .catch((e) => toast.push(errorMessage(e), 'error'))
            }
          >
            CSV
          </Button>
        )
      }
    >
      {children}
    </Card>
  );
}

function Loadable<T>({
  q,
  children,
}: {
  q: { data?: T; isError: boolean; refetch: () => unknown };
  children: (d: T) => ReactNode;
}) {
  if (q.isError)
    return <ErrorState message="We could not load this report." onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-32" />;
  return <>{children(q.data)}</>;
}

function GroupTable({
  rows,
  keyLabel,
  name,
}: {
  rows: CrmGroupRow[];
  keyLabel: string;
  name: (k: string | null) => string;
}) {
  if (rows.length === 0) return <EmptyState compact title="No leads match these filters" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="text-caption text-text-secondary">
          <tr className="border-b border-border">
            <th className="py-2 pr-3">{keyLabel}</th>
            <th className="py-2 pr-3">Leads</th>
            <th className="py-2 pr-3">Contacted</th>
            <th className="py-2 pr-3">Interested</th>
            <th className="py-2 pr-3">Demo completed</th>
            <th className="py-2 pr-3">Onboarding</th>
            <th className="py-2 pr-3">Activated (approved)</th>
            <th className="py-2">First event, of activated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.key ?? 'none'}>
              <td className="py-2 pr-3 font-medium text-text-primary">{name(r.key)}</td>
              <td className="py-2 pr-3 tabular-nums">{r.total}</td>
              <td className="py-2 pr-3">
                <RatioText value={r.contacted} />
              </td>
              <td className="py-2 pr-3">
                <RatioText value={r.interested} />
              </td>
              <td className="py-2 pr-3">
                <RatioText value={r.demoCompleted} />
              </td>
              <td className="py-2 pr-3">
                <RatioText value={r.onboarding} />
              </td>
              <td className="py-2 pr-3">
                <RatioText value={r.activated} />
              </td>
              <td className="py-2">
                <RatioText value={r.firstEvent} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Reports() {
  const { me } = useCrmMe();
  const [draft, setDraft] = useState<CrmFilterState>(EMPTY_FILTERS);
  const [f, setF] = useState<CrmFilterState>(EMPTY_FILTERS);
  const [bucket, setBucket] = useState<'week' | 'month'>('week');
  const countries = [...new Set((me?.teams ?? []).filter((t) => t.manages).map((t) => t.country))];
  const filters: CrmReportFilters = {
    from: dayStartIso(f.from),
    to: dayEndExclusiveIso(f.to),
    country: f.country || undefined,
    source: f.source || undefined,
    stage: f.stage || undefined,
    assignee: f.assignee || undefined,
    city: f.city || undefined,
  };
  const r = api.admin.crm.reports;
  const key = (name: string, extra?: unknown) => ['crm', 'reports', name, filters, extra];
  const funnel = useQuery({ queryKey: key('funnel'), queryFn: () => r.funnel(filters) });
  const conversion = useQuery({
    queryKey: key('conversion'),
    queryFn: () => r.conversion(filters),
  });
  const byCountry = useQuery({ queryKey: key('by-country'), queryFn: () => r.byCountry(filters) });
  const bySource = useQuery({ queryKey: key('by-source'), queryFn: () => r.bySource(filters) });
  const activity = useQuery({
    queryKey: key('activity', bucket),
    queryFn: () => r.activity({ ...filters, bucket }),
  });
  const aging = useQuery({ queryKey: key('aging'), queryFn: () => r.aging(filters) });
  const setD = (k: keyof CrmFilterState) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Acquisition reports"
        description="Leads in the teams you manage. Dates filter by when a lead was added, except activity, which filters by when it happened."
      />

      <Card padding="md">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setF(draft);
          }}
        >
          <Input label="Added from" type="date" value={draft.from} onChange={setD('from')} />
          <Input label="Added to" type="date" value={draft.to} onChange={setD('to')} />
          <Select label="Country" value={draft.country} onChange={setD('country')}>
            <option value="">{countries.length > 1 ? 'India and USA' : 'All my teams'}</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {countryName(c)}
              </option>
            ))}
          </Select>
          <Input label="City" value={draft.city} onChange={setD('city')} />
          <Select label="Source" value={draft.source} onChange={setD('source')}>
            <option value="">Every source</option>
            {CRM_LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </Select>
          <Select label="Stage now" value={draft.stage} onChange={setD('stage')}>
            <option value="">Every stage</option>
            {CRM_STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </Select>
          <Select label="Assigned to" value={draft.assignee} onChange={setD('assignee')}>
            <option value="">Anybody</option>
            <option value="me">Me</option>
            <option value="none">Unassigned</option>
          </Select>
          <div className="flex items-end gap-2">
            <Button type="submit">Apply</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                setF(EMPTY_FILTERS);
              }}
            >
              Clear
            </Button>
          </div>
        </form>
      </Card>

      <Section title="Funnel" csv="funnel" filters={filters}>
        <Loadable q={funnel}>
          {(d) =>
            d.cohort === 0 ? (
              <EmptyState compact title="No leads match these filters" />
            ) : (
              <div className="space-y-4">
                <p className="text-caption text-text-muted">
                  {d.cohortDefinition} A lead counts at a stage when it reached that stage or a
                  later one. Lost now: {ratioText(d.lost)}.
                </p>
                <ol className="space-y-2">
                  {d.stages.map((s) => {
                    const pct = s.ofCohort.denominator
                      ? (s.reached / s.ofCohort.denominator) * 100
                      : 0;
                    return (
                      <li
                        key={s.stage}
                        className="grid grid-cols-[160px_1fr] items-center gap-3 text-sm sm:grid-cols-[200px_1fr_220px]"
                      >
                        <span className="text-text-primary">{stageLabel(s.stage)}</span>
                        <span className="h-3 rounded-full bg-background-subtle" aria-hidden>
                          <span
                            className="block h-3 rounded-full bg-action-primary"
                            style={{ width: `${Math.max(pct, s.reached > 0 ? 2 : 0)}%` }}
                          />
                        </span>
                        <span className="col-span-2 text-caption text-text-secondary sm:col-span-1">
                          <RatioText value={s.ofCohort} of="leads" />
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Kpi
                    label="Activated (organizer approved)"
                    value={ratioText(d.derived.activated, 'leads')}
                  />
                  <Kpi
                    label="First published event"
                    value={ratioText(d.derived.firstEvent, 'activated')}
                  />
                </div>
              </div>
            )
          }
        </Loadable>
      </Section>

      <Section title="Conversion by stage" filters={filters}>
        <Loadable q={funnel}>
          {(d) => (
            <table className="w-full text-left text-sm">
              <thead className="text-caption text-text-secondary">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">From</th>
                  <th className="py-2 pr-3">To</th>
                  <th className="py-2">Moved on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.conversionByStage.map((c) => (
                  <tr key={c.to}>
                    <td className="py-2 pr-3">{stageLabel(c.from)}</td>
                    <td className="py-2 pr-3">{stageLabel(c.to)}</td>
                    <td className="py-2">
                      <RatioText value={c.rate} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loadable>
      </Section>

      <Section title="India and USA" csv="by-country" filters={filters}>
        <Loadable q={byCountry}>
          {(d) => <GroupTable rows={d.rows} keyLabel="Country" name={(k) => countryName(k)} />}
        </Loadable>
      </Section>

      <Section title="Lead source effectiveness" csv="by-source" filters={filters}>
        <Loadable q={bySource}>
          {(d) => (
            <GroupTable rows={d.rows} keyLabel="Source" name={(k) => (k ? sourceLabel(k) : '-')} />
          )}
        </Loadable>
      </Section>

      <Section title="Onboarding and first-event conversion" filters={filters}>
        <Loadable q={conversion}>
          {(d) => (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label="Reached onboarding" value={d.onboarding.reached} />
                <Kpi
                  label="Of those, linked to an account"
                  value={ratioText(d.onboarding.linked)}
                />
                <Kpi label="Of those, approved to sell" value={ratioText(d.onboarding.approved)} />
                <Kpi
                  label="Approved with a first published event"
                  value={ratioText(d.firstEvent.withFirstPublishedEvent)}
                  hint={
                    d.firstEvent.medianDaysFromLinkToFirstEvent != null
                      ? `Median ${d.firstEvent.medianDaysFromLinkToFirstEvent} days from link to first event`
                      : undefined
                  }
                />
              </div>
              <p className="text-caption text-text-muted">
                Linked leads approved: {ratioText(d.firstEvent.approved)}. Marked Activated by hand:{' '}
                {d.manualStage.activated}
                {d.manualStage.activatedButNotApprovedNow > 0 &&
                  `, of which ${d.manualStage.activatedButNotApprovedNow} are not approved now (for example suspended)`}
                .
              </p>
            </div>
          )}
        </Loadable>
      </Section>

      <Section title="Logged activity" csv="activity" filters={{ ...filters, bucket }}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption text-text-muted">{LOGGED_NOT_SENT}</p>
          <SegmentedControl<'week' | 'month'>
            label="Group by"
            value={bucket}
            onChange={setBucket}
            options={[
              { value: 'week', label: 'Weekly' },
              { value: 'month', label: 'Monthly' },
            ]}
          />
        </div>
        <Loadable q={activity}>
          {(d) =>
            d.rows.length === 0 ? (
              <EmptyState compact title="No activity logged in this period" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-caption text-text-secondary">
                    <tr className="border-b border-border">
                      <th className="py-2 pr-3">{d.bucket === 'week' ? 'Week of' : 'Month of'}</th>
                      <th className="py-2 pr-3">Logged</th>
                      {CRM_ACTIVITY_TYPES.map((t) => (
                        <th key={t} className="py-2 pr-3">
                          {activityLabel(t)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.rows.map((row) => (
                      <tr key={row.period}>
                        <td className="py-2 pr-3">{dateOnly(row.period)}</td>
                        <td className="py-2 pr-3 tabular-nums font-medium">{row.total}</td>
                        {CRM_ACTIVITY_TYPES.map((t) => (
                          <td key={t} className="py-2 pr-3 tabular-nums">
                            {row[t]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Loadable>
      </Section>

      <Section title="Lead aging (time in stage)" csv="aging" filters={filters}>
        <Loadable q={aging}>
          {(d) => (
            <div className="space-y-2">
              <p className="text-caption text-text-muted">{d.definition}</p>
              <table className="w-full text-left text-sm">
                <thead className="text-caption text-text-secondary">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3">Stage</th>
                    <th className="py-2 pr-3">Leads</th>
                    <th className="py-2 pr-3">Average days</th>
                    <th className="py-2 pr-3">Longest</th>
                    <th className="py-2">Over 30 days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {d.rows.map((row) => (
                    <tr key={row.stage}>
                      <td className="py-2 pr-3">{stageLabel(row.stage)}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.count}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.avgDays ?? '-'}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.maxDays ?? '-'}</td>
                      <td className="py-2">
                        <RatioText value={row.over30Days} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </Section>
    </div>
  );
}
