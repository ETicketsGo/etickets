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
  Drawer,
  money,
  dateTime,
  type Column,
  type OrderRow,
} from '@eticketsgo/web-kit';

const STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
];

export default function OrdersTab() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [selected, setSelected] = useState<OrderRow | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['orders', id, page, status, applied],
    queryFn: () =>
      api.events.orders(id, {
        page,
        pageSize: 15,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  const columns: Column<OrderRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (o) => (
        <span className="font-mono text-xs text-text-muted">{o.reference ?? '—'}</span>
      ),
    },
    {
      key: 'buyer',
      header: 'Buyer',
      render: (o) => (
        <div>
          <p className="font-medium text-text-primary">{o.buyerName}</p>
          <p className="text-xs text-text-muted">{o.buyerEmail}</p>
        </div>
      ),
    },
    { key: 'tickets', header: 'Tickets', render: (o) => o.ticketCount },
    {
      key: 'total',
      header: 'Total',
      sortable: true,
      sortValue: (o) => o.totalMinor,
      render: (o) => money(o.totalMinor),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      sortValue: (o) => o.status,
      render: (o) => <StatusBadge status={o.status} />,
    },
    {
      key: 'payment',
      header: 'Payment',
      render: (o) => (o.paymentStatus ? <StatusBadge status={o.paymentStatus} /> : '—'),
    },
    {
      key: 'date',
      header: 'Date',
      sortable: true,
      sortValue: (o) => o.createdAt,
      render: (o) => dateTime(o.createdAt),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search reference, buyer name or email…"
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
        rowKey={(o) => o.id}
        onRowClick={setSelected}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}

      <Drawer open={!!selected} onClose={() => setSelected(null)} title="Order details">
        {selected && (
          <dl className="space-y-2 text-sm">
            <Field label="Order ID" value={selected.id} mono />
            <Field label="Buyer" value={selected.buyerName} />
            <Field label="Email" value={selected.buyerEmail} />
            <Field label="Tickets" value={String(selected.ticketCount)} />
            <Field label="Total" value={money(selected.totalMinor)} />
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <StatusBadge status={selected.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Payment</dt>
              <dd>
                {selected.paymentStatus ? <StatusBadge status={selected.paymentStatus} /> : '—'}
              </dd>
            </div>
            <Field label="Placed" value={dateTime(selected.createdAt)} />
          </dl>
        )}
      </Drawer>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`text-right text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
