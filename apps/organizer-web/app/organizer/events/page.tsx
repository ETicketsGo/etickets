'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  Button,
  DataTable,
  StatusBadge,
  ButtonLink,
  Select,
  SearchInput,
  Pagination,
  PageHeader,
  dateOnly,
  useToast,
  errorMessage,
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
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.events.duplicate(id),
    onSuccess: (created) => {
      toast.push('Event duplicated as a new draft.', 'success');
      qc.invalidateQueries({ queryKey: ['events', activeOrg.id] });
      router.push(`/organizer/events/${created.id}`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const rows = useMemo(() => {
    let list = data ?? [];
    if (status) list = list.filter((e) => e.status === status);
    if (q) list = list.filter((e) => e.title.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [data, status, q]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [rows, currentPage],
  );

  const columns: Column<OrgEventRow>[] = [
    {
      key: 'title',
      header: 'Event',
      sortable: true,
      sortValue: (e) => e.title.toLowerCase(),
      render: (e) => (
        <div>
          <p className="font-medium text-text-primary">{e.title}</p>
          <p className="text-xs text-text-muted">
            {e.category} · {e.venue.city}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (e) => e.status,
      render: (e) => <StatusBadge status={e.status} />,
    },
    { key: 'sessions', header: 'Sessions', render: (e) => e._count.sessions },
    { key: 'bookings', header: 'Bookings', render: (e) => e._count.bookings },
    {
      key: 'created',
      header: 'Created',
      sortable: true,
      sortValue: (e) => e.createdAt,
      render: (e) => dateOnly(e.createdAt),
    },
    {
      key: 'actions',
      header: '',
      render: (e) => (
        <div className="flex justify-end gap-2">
          <ButtonLink href={`/organizer/events/${e.id}`} variant="outline" size="sm">
            Manage
          </ButtonLink>
          <Button
            variant="outline"
            size="sm"
            loading={duplicate.isPending && duplicate.variables === e.id}
            onClick={() => duplicate.mutate(e.id)}
          >
            Duplicate
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Events"
        action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search events…"
        />
        <Select
          aria-label="Filter by status"
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
        rows={pageRows}
        loading={isLoading}
        rowKey={(e) => e.id}
        onRowClick={(e) => router.push(`/organizer/events/${e.id}`)}
        empty={<div className="p-8 text-center text-text-muted">No events match your filters.</div>}
      />
      <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}
