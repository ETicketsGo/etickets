'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Card,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  Pagination,
  Select,
  recordedAt,
  type Column,
  type CrmActivity,
} from '@eticketsgo/web-kit';
import { CRM_ACTIVITY_TYPES } from '@eticketsgo/shared-types';
import { CrmGate, NoTeamNotice, useCrmMe } from '../../../../components/crm/crm-ui';
import {
  LOGGED_NOT_SENT,
  activityLabel,
  countryName,
  dayEndExclusiveIso,
  dayStartIso,
  outcomeLabel,
} from '../../../../lib/crm';

/**
 * Logged outreach, newest first. A record of what people did; the platform sent none of it.
 */
export default function ActivitiesPage() {
  return (
    <CrmGate>
      <Activities />
    </CrmGate>
  );
}

function Activities() {
  const { me, access } = useCrmMe();
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [user, setUser] = useState(access.manager ? '' : 'me');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [country, setCountry] = useState('');
  const countries = [...new Set((me?.teams ?? []).map((t) => t.country))];
  const params = {
    page,
    pageSize: 25,
    type: type || undefined,
    user: user || undefined,
    from: dayStartIso(from),
    to: dayEndExclusiveIso(to),
    country: country || undefined,
  };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['crm', 'activities', params],
    queryFn: () => api.admin.crm.activities(params),
  });
  const set = (fn: (v: string) => void) => (e: { target: { value: string } }) => {
    fn(e.target.value);
    setPage(1);
  };

  const columns: Column<CrmActivity>[] = [
    {
      key: 'when',
      header: 'When',
      className: 'whitespace-nowrap',
      render: (a) => <span className="text-text-secondary">{recordedAt(a.occurredAt)}</span>,
    },
    {
      key: 'what',
      header: 'Logged activity',
      render: (a) => (
        <div>
          <p className="font-medium text-text-primary">{activityLabel(a.type)}</p>
          {a.outcome && <p className="text-caption text-text-muted">{outcomeLabel(a.outcome)}</p>}
        </div>
      ),
    },
    {
      key: 'lead',
      header: 'Lead',
      render: (a) => (
        <Link
          href={`/admin/acquisition/prospects/${a.leadId}`}
          className="text-text-primary underline-offset-2 hover:underline"
        >
          {a.lead?.organizationName ?? 'Lead'}
        </Link>
      ),
    },
    {
      key: 'who',
      header: 'By',
      className: 'whitespace-nowrap',
      render: (a) => <span className="text-text-secondary">{a.responsible.fullName}</span>,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (a) => (
        <span className="line-clamp-2 text-caption text-text-muted">{a.notes ?? ''}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Activities" description={LOGGED_NOT_SENT} />
      <NoTeamNotice me={me} />
      <Card padding="md">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select label="Kind" value={type} onChange={set(setType)}>
            <option value="">Every kind</option>
            {CRM_ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {activityLabel(t)}
              </option>
            ))}
          </Select>
          {access.manager && (
            <Select label="By" value={user} onChange={set(setUser)}>
              <option value="">Anybody on my teams</option>
              <option value="me">Me</option>
            </Select>
          )}
          {countries.length > 1 && (
            <Select label="Country" value={country} onChange={set(setCountry)}>
              <option value="">India and USA</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {countryName(c)}
                </option>
              ))}
            </Select>
          )}
          <Input label="From" type="date" value={from} onChange={set(setFrom)} />
          <Input label="To" type="date" value={to} onChange={set(setTo)} />
        </div>
      </Card>
      <Card>
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? 'We could not load the activities.' : undefined}
          onRetry={() => refetch()}
          rowKey={(a) => a.id}
          mobile="cards"
          empty={
            <EmptyState
              compact
              title="No logged activity matches"
              hint="Activities are logged from a lead's page."
            />
          }
        />
        {data && data.meta.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
