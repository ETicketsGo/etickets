'use client';

import { useQuery } from '@tanstack/react-query';
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
  type Column,
  type AdminMovieRow,
} from '@eticketsgo/web-kit';

const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

export default function AdminMoviesPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'movies', page, status, q],
    queryFn: () =>
      api.admin.movies({ page, pageSize: 15, status: status || undefined, q: q || undefined }),
  });

  const columns: Column<AdminMovieRow>[] = [
    {
      key: 'title',
      header: 'Title',
      render: (m) => (
        <div>
          <p className="font-medium text-text-primary">{m.title}</p>
          <p className="text-xs text-text-muted">{m.organizationName}</p>
        </div>
      ),
    },
    { key: 'language', header: 'Language', render: (m) => m.language },
    { key: 'certificate', header: 'Certificate', render: (m) => m.certificate ?? '—' },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
    {
      key: 'created',
      header: 'Created',
      render: (m) => dateOnly(m.createdAt),
      sortable: true,
      sortValue: (m) => m.createdAt,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Movies" description="Oversee movies across the platform." />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search title…"
        />
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
              {s.replaceAll('_', ' ')}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No movies match these filters" />}
        rowKey={(m) => m.id}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
