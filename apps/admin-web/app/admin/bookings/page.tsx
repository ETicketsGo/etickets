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
  money,
  dateTime,
  type Column,
  type AdminBookingRow,
} from '@eticketsgo/web-kit';

const STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  'DISPUTED',
];

export default function AdminBookings() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'bookings', page, status, applied],
    queryFn: () =>
      api.admin.bookings({
        page,
        pageSize: 15,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  const columns: Column<AdminBookingRow>[] = [
    { key: 'buyer', header: 'Buyer', render: (b) => b.buyerEmail },
    { key: 'event', header: 'Event', render: (b) => b.event.title },
    {
      key: 'total',
      header: 'Total',
      render: (b) => money(b.totalMinor),
      sortable: true,
      sortValue: (b) => b.totalMinor,
    },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.status} /> },
    {
      key: 'payment',
      header: 'Payment',
      render: (b) => (b.paymentStatus ? <StatusBadge status={b.paymentStatus} /> : '—'),
    },
    {
      key: 'date',
      header: 'Date',
      render: (b) => dateTime(b.createdAt),
      sortable: true,
      sortValue: (b) => b.createdAt,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Bookings" description="Search and inspect all bookings." />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search buyer email…"
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
        empty={<EmptyState title="No bookings match these filters" />}
        rowKey={(b) => b.id}
        onRowClick={(b) => router.push(`/admin/bookings/${b.id}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
