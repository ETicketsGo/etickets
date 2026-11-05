'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  recordedAt,
} from '@eticketsgo/web-kit';
import {
  CrmGate,
  Kpi,
  NoTeamNotice,
  QuickLeadDialog,
  RatioText,
  StageBadge,
  useCrmMe,
} from '../../../components/crm/crm-ui';
import { countryName, followUpState, LOGGED_NOT_SENT } from '../../../lib/crm';

/**
 * Organizer Acquisition: the overview.
 *
 * An agent sees their own leads and follow-ups; a manager sees the teams they manage. The
 * stage cards say where leads ARE now. "Activated" and "first event" come from the platform's
 * own records (an approved organizer, its own published events), never from a stage somebody
 * picked, and each share names what it is a share of.
 */
export default function AcquisitionOverviewPage() {
  return (
    <CrmGate>
      <Overview />
    </CrmGate>
  );
}

function Overview() {
  const { me, access } = useCrmMe();
  const [country, setCountry] = useState('');
  const [adding, setAdding] = useState(false);
  const countries = [...new Set((me?.teams ?? []).map((t) => t.country))];

  const overview = useQuery({
    queryKey: ['crm', 'overview', country],
    queryFn: () => api.admin.crm.reports.overview({ country: country || undefined }),
  });
  const mine = useQuery({
    queryKey: ['crm', 'follow-ups', 'mine-next'],
    queryFn: () => api.admin.crm.followUps({ owner: 'me', status: 'OPEN', pageSize: 8 }),
  });

  const o = overview.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizer Acquisition"
        description={
          access.manager
            ? 'Prospects in the teams you manage, and what needs doing next.'
            : 'Your prospects, and what needs doing next.'
        }
        action={
          <Button icon={Plus} onClick={() => setAdding(true)}>
            Add prospect
          </Button>
        }
      />
      <NoTeamNotice me={me} />

      {countries.length > 1 && (
        <Card padding="md">
          <div className="max-w-xs">
            <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">India and USA</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {countryName(c)}
                </option>
              ))}
            </Select>
          </div>
        </Card>
      )}

      {overview.isError ? (
        <ErrorState message="We could not load the overview." onRetry={() => overview.refetch()} />
      ) : !o ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <section aria-labelledby="kpi-pipeline" className="space-y-3">
            <h2 id="kpi-pipeline" className="text-title font-semibold text-text-primary">
              Where leads are now
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Kpi label="Total prospects" value={o.totalProspects} hint="Not archived" />
              <Kpi label="New" value={o.newInWindow} hint="Added in the last 30 days" />
              <Kpi label="Contacted" value={o.currentStage.CONTACTED} />
              <Kpi label="Interested" value={o.currentStage.RESPONDED_INTERESTED} />
              <Kpi label="Demos scheduled" value={o.currentStage.DEMO_SCHEDULED} />
              <Kpi label="Demos completed" value={o.currentStage.DEMO_COMPLETED} />
              <Kpi label="Negotiation" value={o.currentStage.NEGOTIATION} />
              <Kpi label="Onboarding" value={o.currentStage.ONBOARDING} />
              <Kpi label="Lost" value={o.currentStage.LOST} />
              <Kpi
                label="Overdue follow-ups"
                value={o.followUps.overdue}
                hint={`${o.followUps.dueThisWeek} more due in the next 7 days`}
              />
            </div>
          </section>

          <section aria-labelledby="kpi-derived" className="space-y-3">
            <h2 id="kpi-derived" className="text-title font-semibold text-text-primary">
              Won, from the platform&apos;s own records
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi
                label="Activated (organizer approved)"
                value={o.derived.activated.numerator}
                hint={`Of ${o.derived.activated.denominator} prospects`}
              />
              <Kpi
                label="With a first published event"
                value={o.derived.activatedWithFirstEvent.numerator}
                hint={`Of ${o.derived.activatedWithFirstEvent.denominator} activated`}
              />
              <Kpi
                label="Linked to an organizer account"
                value={o.derived.linked.numerator}
                hint={`Of ${o.derived.linked.denominator} prospects`}
              />
            </div>
            <p className="text-caption text-text-muted">
              Activated means the linked organizer was approved to sell by the organizer review.
              Marked Activated by hand: {o.currentStage.ACTIVATED}. Logged activities in the last 30
              days: {o.activitiesLoggedInWindow}. {LOGGED_NOT_SENT}
            </p>
            <p className="text-caption text-text-muted">
              Activation rate: <RatioText value={o.derived.activated} of="prospects" />.
            </p>
          </section>
        </>
      )}

      <Card
        title="My next follow-ups"
        action={
          <ButtonLink href="/admin/acquisition/follow-ups" variant="outline" size="sm">
            All follow-ups
          </ButtonLink>
        }
      >
        {mine.isError ? (
          <ErrorState message="We could not load your follow-ups." onRetry={() => mine.refetch()} />
        ) : mine.isLoading ? (
          <Skeleton className="h-24" />
        ) : (mine.data?.data.length ?? 0) === 0 ? (
          <EmptyState
            compact
            title="Nothing scheduled"
            hint="Log an activity on a lead to set one."
          />
        ) : (
          <ul className="divide-y divide-border">
            {mine.data!.data.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span
                  className={`w-44 shrink-0 tabular-nums ${
                    followUpState(f.dueAt) === 'overdue'
                      ? 'font-medium text-status-error'
                      : 'text-text-muted'
                  }`}
                >
                  {recordedAt(f.dueAt)}
                </span>
                <Link
                  href={`/admin/acquisition/prospects/${f.leadId}`}
                  className="font-medium text-text-primary underline-offset-2 hover:underline"
                >
                  {f.lead?.organizationName ?? 'Lead'}
                </Link>
                <span className="text-text-secondary">{f.title}</span>
                {f.lead && <StageBadge stage={f.lead.stage} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <QuickLeadDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
