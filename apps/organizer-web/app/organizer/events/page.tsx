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
  dateOnly,
  type Column,
  type OrgEventRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'COMPLETED',
  'CANCELLED',
];

export default function OrganizerEvents() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });

  const rows = useMemo(() => {
    let list = data ?? [];
    if (status) list = list.filter((e) => e.status === status);
    if (q) list = list.filter((e) => e.title.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [data, status, q]);

  const columns: Column<OrgEventRow>[] = [
    {
      key: 'title',
      header: 'Event',
      render: (e) => (
        <div>
          <p className="font-medium text-text-primary">{e.title}</p>
          <p className="text-xs text-text-muted">
            {e.category} · {e.venue.city}
          </p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    { key: 'sessions', header: 'Sessions', render: (e) => e._count.sessions },
    { key: 'bookings', header: 'Bookings', render: (e) => e._count.bookings },
    { key: 'created', header: 'Created', render: (e) => dateOnly(e.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Events"
        action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput value={q} onChange={setQ} placeholder="Search events…" />
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
        rowKey={(e) => e.id}
        onRowClick={(e) => router.push(`/organizer/events/${e.id}`)}
        empty={<div className="p-8 text-center text-text-muted">No events match your filters.</div>}
      />
    </div>
  );
}
