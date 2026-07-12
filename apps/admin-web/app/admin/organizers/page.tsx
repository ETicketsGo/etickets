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
  type Organization,
} from '@eticketsgo/web-kit';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];

export default function OrganizersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'organizers', page, status],
    queryFn: () => api.admin.organizers({ page, pageSize: 15, status: status || undefined }),
  });

  const columns: Column<Organization>[] = [
    {
      key: 'name',
      header: 'Organization',
      render: (o) => <span className="font-medium text-text-primary">{o.name}</span>,
    },
    { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
    { key: 'events', header: 'Events', render: (o) => o._count?.events ?? 0 },
    { key: 'members', header: 'Members', render: (o) => o._count?.members ?? 0 },
    { key: 'created', header: 'Joined', render: (o) => dateOnly(o.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Organizers" description="Review and manage organizer accounts." />
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
            {titleize(s)}
          </option>
        ))}
      </Select>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        rowKey={(o) => o.id}
        onRowClick={(o) => router.push(`/admin/organizers/${o.id}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}

function titleize(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
