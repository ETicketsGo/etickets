'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  DataTable,
  StatusBadge,
  ButtonLink,
  Select,
  SearchInput,
  PageHeader,
  EmptyState,
  type Column,
  type Movie,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

export default function OrganizerMovies() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['movies', activeOrg.id],
    queryFn: () => api.movies.list(activeOrg.id),
  });

  const rows = useMemo(() => {
    let list = data ?? [];
    if (status) list = list.filter((m) => m.status === status);
    if (q) list = list.filter((m) => m.title.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [data, status, q]);

  const columns: Column<Movie>[] = [
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      sortValue: (m) => m.title.toLowerCase(),
      render: (m) => (
        <div>
          <p className="font-medium text-text-primary">{m.title}</p>
          <p className="text-xs text-text-muted">{m.genres.join(', ') || '—'}</p>
        </div>
      ),
    },
    { key: 'language', header: 'Language', render: (m) => m.language },
    { key: 'certificate', header: 'Certificate', render: (m) => m.certificate ?? '—' },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (m) => m.status,
      render: (m) => <StatusBadge status={m.status} />,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Movies"
        action={<ButtonLink href="/organizer/movies/new">New movie</ButtonLink>}
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput value={q} onChange={setQ} placeholder="Search movies…" />
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
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
        rows={rows}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        rowKey={(m) => m.id}
        onRowClick={(m) => router.push(`/organizer/movies/${m.id}`)}
        empty={
          <EmptyState
            title="No movies yet"
            hint="Create your first movie to start scheduling screenings."
          />
        }
      />
    </div>
  );
}
