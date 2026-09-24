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

  /*
    ── WHO BOUGHT WHAT, THEN WHAT IT COST, THEN WHERE IT GOT TO ─────────────────────
    Reference, buyer, event, total, status, payment and date made seven columns, two of them
    free text, so this queue was one of the two admin tables still wider than its box. A booking
    reads as three facts, not seven: the sale, the money, and how far it got.
  */
  const columns: Column<AdminBookingRow>[] = [
    {
      key: 'sale',
      header: 'Booking',
      render: (b) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{b.event.title}</p>
          <p className="text-caption text-text-secondary">{b.buyerEmail}</p>
          <p className="font-mono text-caption text-text-muted">{b.reference ?? 'no reference'}</p>
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      className: 'whitespace-nowrap tabular-nums',
      render: (b) => money(b.totalMinor, b.currency),
      sortable: true,
      sortValue: (b) => b.totalMinor,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (b) => (
        <div className="space-y-1">
          <StatusBadge status={b.status} />
          {/* The payment is the booking's other half, and it can disagree with it. */}
          {b.paymentStatus ? (
            <p className="text-caption text-text-muted">
              {/* "requires_payment" is a machine's word for it, and this line is read by a person. */}
              Payment: {b.paymentStatus.toLowerCase().replaceAll('_', ' ')}
            </p>
          ) : (
            <p className="text-caption text-text-muted">No payment</p>
          )}
          <p className="text-caption text-text-muted">{dateTime(b.createdAt)}</p>
        </div>
      ),
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
          placeholder="Search reference or buyer email…"
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
