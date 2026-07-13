'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Select,
  SearchInput,
  Pagination,
  PageHeader,
  EmptyState,
  dateOnly,
  titleCase,
  type Column,
  type Organization,
} from '@eticketsgo/web-kit';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];

export default function OrganizersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'organizers', page, status],
    queryFn: () => api.admin.organizers({ page, pageSize: 15, status: status || undefined }),
  });

  const query = q.trim().toLowerCase();
  const rows = query
    ? data?.data.filter((o) => o.name.toLowerCase().includes(query))
    : data?.data;

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
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput value={q} onChange={setQ} placeholder="Search organization…" />
        <Select
          aria-label="Status filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No organizers match these filters" />}
        rowKey={(o) => o.id}
        onRowClick={(o) => router.push(`/admin/organizers/${o.id}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
