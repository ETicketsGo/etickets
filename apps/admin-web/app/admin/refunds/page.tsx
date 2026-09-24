'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Badge,
  Card,
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
  type RefundRow,
} from '@eticketsgo/web-kit';

const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED'];

export default function AdminRefunds() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('REQUESTED');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'refunds', page, status, applied],
    queryFn: () =>
      api.admin.refunds({
        page,
        pageSize: 15,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  /*
    ── WHAT THE REQUEST IS, THEN WHAT IT COSTS, THEN WHERE IT GOT TO ────────────────
    Buyer, amount, reason, status and date put a free-text reason in its own column beside four
    others. The reason is the request - it is what the decision turns on - so it reads under the
    sale it belongs to rather than clipped to one line in the middle of the row.

    The search reaches the database now. It used to filter the fetched page, so a buyer chasing
    their money was findable only if their request was among the newest fifteen, which is the
    opposite of the ones that need chasing.
  */
  const columns: Column<RefundRow>[] = [
    {
      key: 'request',
      header: 'Refund request',
      render: (r) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">
            {r.booking?.event?.title ?? 'Event not named'}
          </p>
          <p className="text-caption text-text-secondary">{r.booking?.buyerEmail ?? 'No buyer'}</p>
          <p className="text-caption text-text-muted">{r.reason}</p>
          {r.booking?.reference && (
            <p className="font-mono text-caption text-text-muted">{r.booking.reference}</p>
          )}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      className: 'whitespace-nowrap tabular-nums',
      render: (r) => money(r.amountMinor, r.booking?.currency),
      sortable: true,
      sortValue: (r) => r.amountMinor,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (r) => (
        <div className="space-y-1">
          <StatusBadge status={r.status} />
          <p className="text-caption text-text-muted">Asked {dateTime(r.createdAt)}</p>
        </div>
      ),
      sortable: true,
      sortValue: (r) => r.createdAt,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refunds"
        description="Money customers have asked for back, and what was decided."
      />
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
          <SearchInput
            value={q}
            onChange={setQ}
            onSubmit={() => {
              setApplied(q.trim());
              setPage(1);
            }}
            placeholder="Search buyer email or booking reference"
          />
          <Select
            aria-label="Status filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Every status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      <Card
        title={status === 'REQUESTED' ? 'Waiting for a decision' : 'Refunds'}
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title={
                status === 'REQUESTED' ? 'Nothing waiting for a decision' : 'No refund matches'
              }
              hint="A booking reference works here too."
            />
          }
          rowKey={(r) => r.id}
          onRowClick={(r) => router.push(`/admin/refunds/${r.id}`)}
        />
        {data && data.meta.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
