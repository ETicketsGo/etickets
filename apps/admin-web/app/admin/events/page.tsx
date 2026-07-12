'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Select,
  Pagination,
  PageHeader,
  dateOnly,
  type Column,
  type AdminEventRow,
} from '@eticketsgo/web-kit';

const STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'CANCELLED',
  'COMPLETED',
  'ARCHIVED',
];

export default function AdminEventsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('UNDER_REVIEW');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'events', page, status],
    queryFn: () => api.admin.events({ page, pageSize: 15, status: status || undefined }),
  });

  const columns: Column<AdminEventRow>[] = [
    {
      key: 'title',
      header: 'Event',
      render: (e) => (
        <div>
          <p className="font-medium text-text-primary">{e.title}</p>
          <p className="text-xs text-text-muted">
            {e.organization.name} · {e.venue.city}
          </p>
        </div>
      ),
    },
    { key: 'category', header: 'Category', render: (e) => e.category },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    { key: 'updated', header: 'Updated', render: (e) => dateOnly(e.updatedAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Events" description="Moderate events across the platform." />
      <Select
        aria-label="Status filter"
        className="max-w-xs"
        value={status}
        onChange={(e) => {
          setStatus(e.target.value);
          setPage(1);
        }}
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replaceAll('_', ' ')}
          </option>
        ))}
      </Select>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        rowKey={(e) => e.id}
        onRowClick={(e) => router.push(`/admin/events/${e.id}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
