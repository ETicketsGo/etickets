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
    {
      key: 'city',
      header: 'City',
      sortable: true,
      sortValue: (c) => c.city,
      render: (c) => c.city,
    },
    {
      key: 'screens',
      header: 'Rooms',
      render: (c) => c.screens?.length ?? 0,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rooms & seat maps"
        action={<ButtonLink href="/organizer/cinemas/new">New location</ButtonLink>}
      />
      <SearchInput value={q} onChange={setQ} placeholder="Search locations…" />
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
            title="No locations yet"
            /*
              The old hint said "to start scheduling screenings", which reads to anybody not
              running a cinema as "this section is not for you" — and this is the only place
              a seat map can be made. Say what it unlocks instead, and say it for the general
              case, with films as the special case rather than the whole story.
            */
            hint="A location holds rooms, and a room with a published seat map is what lets buyers pick their own seat — for a concert or a play, not only a film."
          />
        }
      />
    </div>
  );
}
