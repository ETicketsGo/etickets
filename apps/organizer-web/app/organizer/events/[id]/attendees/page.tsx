'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Select,
  SearchInput,
  Pagination,
  Button,
  Badge,
  dateTime,
  type Column,
  type AttendeeRow,
} from '@eticketsgo/web-kit';

const STATUSES = ['ACTIVE', 'CHECKED_IN', 'REFUNDED', 'CANCELLED', 'VOID'];

function toCsv(rows: AttendeeRow[]): string {
  const head = ['Serial', 'Holder', 'Email', 'Ticket type', 'Status', 'Session', 'Checked in'];
  const body = rows.map((r) =>
    [
      r.serial,
      r.holderName ?? '',
      r.holderEmail ?? '',
      r.ticketType,
      r.status,
      r.sessionStartsAt,
      r.checkedInAt ?? '',
    ]
      .map((c) => `"${String(c).replaceAll('"', '""')}"`)
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
}

export default function AttendeesTab() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['attendees', id, page, status, applied],
    queryFn: () =>
      api.events.attendees(id, {
        page,
        pageSize: 20,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  const columns: Column<AttendeeRow>[] = [
    {
      key: 'holder',
      header: 'Attendee',
      sortable: true,
      sortValue: (a) => (a.holderName ?? '').toLowerCase(),
      render: (a) => (
        <div>
          <p className="font-medium text-text-primary">{a.holderName ?? '—'}</p>
          <p className="text-xs text-text-muted">{a.holderEmail ?? ''}</p>
        </div>
      ),
    },
    {
      key: 'serial',
      header: 'Serial',
      render: (a) => <span className="font-mono text-xs">{a.serial}</span>,
    },
    { key: 'type', header: 'Ticket', render: (a) => a.ticketType },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (a) => a.status,
      render: (a) => <StatusBadge status={a.status} />,
    },
    {
      key: 'checkin',
      header: 'Check-in',
      sortable: true,
      sortValue: (a) => a.checkedInAt ?? '',
      render: (a) =>
        a.checkedInAt ? (
          <Badge tone="info">{dateTime(a.checkedInAt)}</Badge>
        ) : (
          <span className="text-text-muted">—</span>
        ),
    },
  ];

  const exportCsv = () => {
    if (!data) return;
    const blob = new Blob([toCsv(data.data)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendees-page-${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search name, email, serial…"
        />
        <Select
          aria-label="Ticket status"
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
        <Button variant="outline" onClick={exportCsv} disabled={!data || data.data.length === 0}>
          Export CSV
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        rowKey={(a) => a.id}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
