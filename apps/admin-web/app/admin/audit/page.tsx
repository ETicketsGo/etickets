'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  DataTable,
  Select,
  Pagination,
  PageHeader,
  titleCase,
  dateTime,
  type Column,
  type AuditRow,
} from '@eticketsgo/web-kit';

const ACTIONS = [
  'BOOKING_CREATED',
  'BOOKING_CONFIRMED',
  'CHECKIN_REVERSED',
  'EVENT_CREATED',
  'EVENT_STATUS_CHANGED',
  'EVENT_SUBMITTED_FOR_REVIEW',
  'MEMBER_INVITED',
  'ORGANIZATION_CREATED',
  'PAYOUT_GENERATED',
  'PAYOUT_PAID',
  'REFUND_REQUESTED',
  'REFUND_COMPLETED',
  'REFUND_REJECTED',
  'TICKET_CHECKED_IN',
];

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'audit', page, action],
    queryFn: () => api.admin.audit({ page, pageSize: 20, action: action || undefined }),
  });

  const columns: Column<AuditRow>[] = [
    {
      key: 'action',
      header: 'Action',
      render: (a) => <span className="font-medium text-text-primary">{titleCase(a.action)}</span>,
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (a) => `${a.entityType}${a.entityId ? ` · ${a.entityId.slice(0, 8)}` : ''}`,
    },
    { key: 'actor', header: 'Actor', render: (a) => a.actor?.email ?? 'system' },
    {
      key: 'correlation',
      header: 'Correlation',
      render: (a) => (
        <span className="font-mono text-xs">{a.correlationId?.slice(0, 8) ?? '—'}</span>
      ),
    },
    { key: 'when', header: 'When', render: (a) => dateTime(a.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Immutable record of privileged actions." />
      <Select
        aria-label="Action filter"
        className="max-w-xs"
        value={action}
        onChange={(e) => {
          setAction(e.target.value);
          setPage(1);
        }}
      >
        <option value="">All actions</option>
        {ACTIONS.map((a) => (
          <option key={a} value={a}>
            {titleCase(a)}
          </option>
        ))}
      </Select>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        rowKey={(a) => a.id}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
