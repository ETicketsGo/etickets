'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Select,
  Pagination,
  PageHeader,
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

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'payments', page, status],
    queryFn: () => api.admin.payments({ page, pageSize: 15, status: status || undefined }),
  });

  const columns: Column<AdminPaymentRow>[] = [
    { key: 'buyer', header: 'Buyer', render: (p) => p.buyerEmail },
    { key: 'amount', header: 'Amount', render: (p) => money(p.amountMinor) },
    { key: 'provider', header: 'Provider', render: (p) => p.provider },
    {
      key: 'ref',
      header: 'Reference',
      render: (p) => <span className="font-mono text-xs">{p.providerRef ?? '—'}</span>,
    },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'date', header: 'Date', render: (p) => dateTime(p.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Payments" description="Payment records (no card data is stored)." />
      <Select
        aria-label="Status filter"
        className="max-w-xs"
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
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        rowKey={(p) => p.id}
        onRowClick={(p) => router.push(`/admin/bookings/${p.bookingId}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
