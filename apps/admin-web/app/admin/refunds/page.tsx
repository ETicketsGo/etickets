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
  type RefundRow,
} from '@eticketsgo/web-kit';

const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED'];

export default function AdminRefunds() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('REQUESTED');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'refunds', page, status],
    queryFn: () => api.admin.refunds({ page, pageSize: 15, status: status || undefined }),
  });

  const columns: Column<RefundRow>[] = [
    { key: 'buyer', header: 'Buyer', render: (r) => r.booking?.buyerEmail ?? '—' },
    { key: 'amount', header: 'Amount', render: (r) => money(r.amountMinor) },
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => <span className="line-clamp-1">{r.reason}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'date', header: 'Requested', render: (r) => dateTime(r.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Refunds" description="Review and process refund requests." />
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
            {s}
          </option>
        ))}
      </Select>
      <DataTable
        columns={columns}
        rows={data?.data}
        loading={isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => router.push(`/admin/refunds/${r.id}`)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
