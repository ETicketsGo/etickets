'use client';

import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  ButtonLink,
  Card,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
} from '@eticketsgo/web-kit';
import { CRM_STAGES } from '@eticketsgo/shared-types';
import { CrmGate, NoTeamNotice, useCrmMe } from '../../../../components/crm/crm-ui';
import {
  countryName,
  followUpState,
  nextActionText,
  stageLabel,
  wholeDays,
} from '../../../../lib/crm';

const PER_COLUMN = 8;

/**
 * The pipeline as columns, one per stage, each counted by the server.
 *
 * A column shows the leads that have waited longest in it first, because the lead that has
 * been "Demo scheduled" for three weeks is the one that needs somebody. Moving a lead happens
 * on the lead itself, where the allowed next stages and their rules are.
 */
export default function PipelinePage() {
  return (
    <CrmGate>
      <Pipeline />
    </CrmGate>
  );
}

function Pipeline() {
  const { me, access } = useCrmMe();
  const [country, setCountry] = useState('');
  const [assignee, setAssignee] = useState(access.manager ? '' : 'me');
  const countries = [...new Set((me?.teams ?? []).map((t) => t.country))];
  const columns = useQueries({
    queries: CRM_STAGES.map((stage) => ({
      queryKey: ['crm', 'leads', 'pipeline', stage, country, assignee],
      queryFn: () =>
        api.admin.crm.leads({
          stage,
          country: country || undefined,
          assignee: assignee || undefined,
          pageSize: PER_COLUMN,
          sort: 'stageAge' as const,
        }),
    })),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description="Every stage, counted, with the leads that have waited longest at the top."
      />
      <NoTeamNotice me={me} />
      {(countries.length > 1 || access.manager) && (
        <Card padding="md">
          <div className="grid max-w-xl gap-3 sm:grid-cols-2">
            {countries.length > 1 && (
              <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="">India and USA</option>
                {countries.map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)}
                  </option>
                ))}
              </Select>
            )}
            {access.manager && (
              <Select
                label="Assigned to"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Anybody</option>
                <option value="me">Me</option>
                <option value="none">Unassigned</option>
              </Select>
            )}
          </div>
        </Card>
      )}

      <div className="overflow-x-auto pb-2">
        <ol className="grid min-w-[1100px] grid-cols-9 gap-3" aria-label="Pipeline stages">
          {CRM_STAGES.map((stage, i) => {
            const q = columns[i];
            return (
              <li
                key={stage}
                className="flex min-w-0 flex-col rounded-lg border border-border bg-background-subtle p-2"
              >
                <div className="mb-2 flex items-baseline justify-between gap-1 px-1">
                  <h2 className="text-caption font-semibold text-text-primary">
                    {stageLabel(stage)}
                  </h2>
                  <span className="text-caption tabular-nums text-text-muted">
                    {q.data ? q.data.meta.total : '-'}
                  </span>
                </div>
                {q.isError ? (
                  <ErrorState message="Could not load." onRetry={() => q.refetch()} />
                ) : !q.data ? (
                  <Skeleton className="h-20" />
                ) : q.data.data.length === 0 ? (
                  <p className="px-1 py-3 text-caption text-text-muted">None</p>
                ) : (
                  <ul className="space-y-2">
                    {q.data.data.map((l) => (
                      <li key={l.id}>
                        <Link
                          href={`/admin/acquisition/prospects/${l.id}`}
                          className="block rounded-md border border-border bg-background-surface p-2 text-sm shadow-sm hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block font-medium text-text-primary">
                            {l.organizationName}
                          </span>
                          <span className="block text-caption text-text-muted">
                            {wholeDays(l.stageChangedAt)}d here
                            {l.assignedTo ? ` - ${l.assignedTo.fullName}` : ' - unassigned'}
                          </span>
                          <span
                            className={`block text-caption ${
                              followUpState(l.nextFollowUpAt) === 'overdue' &&
                              !['LOST', 'ACTIVATED'].includes(l.stage)
                                ? 'text-status-error'
                                : 'text-text-muted'
                            }`}
                          >
                            {nextActionText(l)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {q.data && q.data.meta.total > PER_COLUMN && (
                  <ButtonLink
                    href={`/admin/acquisition/prospects?stage=${stage}`}
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                  >
                    All {q.data.meta.total}
                  </ButtonLink>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
