'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  DataTable,
  Input,
  Button,
  Pagination,
  PageHeader,
  titleCase,
  dateTime,
  type Column,
  type AuditRow,
} from '@eticketsgo/web-kit';

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit', page, applied],
    queryFn: () => api.admin.audit({ page, pageSize: 20, action: applied || undefined }),
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
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(action);
          setPage(1);
        }}
      >
        <Input
          id="action"
          placeholder="Filter by action (e.g. REFUND_COMPLETED)"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <DataTable columns={columns} rows={data?.data} loading={isLoading} rowKey={(a) => a.id} />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
