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
  type AdminPaymentRow,
} from '@eticketsgo/web-kit';

const STATUSES = [
  'REQUIRES_PAYMENT',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
];

export default function AdminPayments() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'payments', page, status],
    queryFn: () => api.admin.payments({ page, pageSize: 15, status: status || undefined }),
  });

  const query = q.trim().toLowerCase();
  const rows = query
    ? data?.data.filter((p) => p.buyerEmail.toLowerCase().includes(query))
    : data?.data;

  const columns: Column<AdminPaymentRow>[] = [
    { key: 'buyer', header: 'Buyer', render: (p) => p.buyerEmail },
    {
      key: 'amount',
      header: 'Amount',
      render: (p) => money(p.amountMinor),
      sortable: true,
      sortValue: (p) => p.amountMinor,
    },
    { key: 'provider', header: 'Provider', render: (p) => p.provider },
    {
      key: 'ref',
      header: 'Reference',
      render: (p) => <span className="font-mono text-xs">{p.providerRef ?? '—'}</span>,
    },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    {
      key: 'date',
      header: 'Date',
      render: (p) => dateTime(p.createdAt),
      sortable: true,
      sortValue: (p) => p.createdAt,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Payments" description="Payment records (no card data is stored)." />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput value={q} onChange={setQ} placeholder="Search buyer email…" />
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
        rows={rows}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No payments match these filters" />}
        rowKey={(p) => p.id}
        onRowClick={(p) => router.push(`/admin/bookings/${p.bookingId}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
