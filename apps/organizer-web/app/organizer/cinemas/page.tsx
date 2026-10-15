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
      header: 'Screens',
      render: (c) => c.screens?.length ?? 0,
    },
  ];

  return (
    <div className="space-y-4">
      {/*
        CINEMAS, called what they are.

        This list was titled "Spaces" and its button said "New space", but every row is a
        cinema - the film business at a venue - and its count was of screens. A space is a
        screen, a hall or an arena; it is added from Venues & seating, and a cinema screen joins
        its venue's cinema there.
      */}
      <PageHeader
        title="Cinemas"
        description="A cinema is the film business at one of your venues. Its screens are spaces, listed in Venues & seating."
        action={
          <ButtonLink href="/organizer/spaces/new?kind=CINEMA_SCREEN">
            Add a cinema screen
          </ButtonLink>
        }
      />
      <SearchInput value={q} onChange={setQ} placeholder="Search cinemas..." />
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
            /*
              The old hint said "to start scheduling screenings", which reads to anybody not
              running a cinema as "this section is not for you" — and this is the only place
              a seat map can be made. Say what it unlocks instead, and say it for the general
              case, with films as the special case rather than the whole story.
            */
            hint="A cinema is made for a venue when you add its first cinema screen. For a concert or a play, add a hall or an arena in Venues & seating instead."
          />
        }
      />
    </div>
  );
}
