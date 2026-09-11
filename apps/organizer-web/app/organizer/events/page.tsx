'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  Button,
  DataTable,
  Dialog,
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
  const [deleting, setDeleting] = useState<OrgEventRow | null>(null);
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

  const remove = useMutation({
    mutationFn: (id: string) => api.events.remove(id),
    onSuccess: () => {
      toast.push('Event deleted.', 'success');
      qc.invalidateQueries({ queryKey: ['events', activeOrg.id] });
      setDeleting(null);
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      setDeleting(null);
    },
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
        /*
          The row itself opens the event, so clicks on these buttons stop here — otherwise a
          Delete would also navigate away from the dialog it just opened.
        */
        <div className="flex justify-end gap-2" onClick={(ev) => ev.stopPropagation()}>
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
          {/*
            Only while nobody has booked. Disabled with the reason rather than hidden, so an
            organizer looking for the button learns why it is not available.
          */}
          <Button
            variant="danger"
            size="sm"
            disabled={e._count.bookings > 0}
            title={
              e._count.bookings > 0
                ? 'This event has bookings, so it cannot be deleted. Pause it instead.'
                : undefined
            }
            aria-label={`Delete ${e.title}`}
            onClick={() => setDeleting(e)}
          >
            Delete
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

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this event?"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              Delete event
            </Button>
          </>
        }
      >
        <p>
          <span className="font-medium text-text-primary">{deleting?.title}</span> will be deleted,
          with its sessions, ticket types and images. This cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}
