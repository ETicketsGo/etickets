'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  DataTable,
  ButtonLink,
  SearchInput,
  PageHeader,
  EmptyState,
  type Column,
  type Cinema,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

export default function OrganizerCinemas() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const [q, setQ] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cinemas', activeOrg.id],
    queryFn: () => api.cinemas.list(activeOrg.id),
  });

  const rows = useMemo(() => {
    const list = data ?? [];
    if (!q) return list;
    const query = q.toLowerCase();
    return list.filter(
      (c) => c.name.toLowerCase().includes(query) || c.city.toLowerCase().includes(query),
    );
  }, [data, q]);

  const columns: Column<Cinema>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div>
          <p className="font-medium text-text-primary">{c.name}</p>
          {c.brand && <p className="text-xs text-text-muted">{c.brand}</p>}
        </div>
      ),
    },
    { key: 'city', header: 'City', sortable: true, sortValue: (c) => c.city, render: (c) => c.city },
    {
      key: 'screens',
      header: 'Screens',
      render: (c) => c.screens?.length ?? 0,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cinemas"
        action={<ButtonLink href="/organizer/cinemas/new">New cinema</ButtonLink>}
      />
      <SearchInput value={q} onChange={setQ} placeholder="Search cinemas…" />
      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        rowKey={(c) => c.id}
        onRowClick={(c) => router.push(`/organizer/cinemas/${c.id}`)}
        empty={
          <EmptyState
            title="No cinemas yet"
            hint="Add a cinema and its screens to start scheduling screenings."
          />
        }
      />
    </div>
  );
}
