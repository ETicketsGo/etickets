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
  GroupedSummary,
  type GroupSelection,
  EmptyState,
  money,
  dateTime,
  type Column,
  type AdminPaymentRow,
} from '@eticketsgo/web-kit';

/**
 * The payment ledger.
 *
 * ── SIX COLUMNS, AND THE ONE FACT THAT MATTERED WAS MISSING ────────────────────────
 * Buyer, amount, provider, reference, status and date: two of those hold long opaque
 * identifiers, the date wrapped onto two lines, and none of them said WHICH SALE the money was
 * for. Somebody looking at a payment almost always arrived from a question about a booking.
 *
 * So a payment reads as three things now - who paid for what, how much, and how it went - with
 * the provider and its reference kept as the detail lines they are. They are still searchable,
 * because a provider's own dashboard hands you a reference and nothing else.
 */
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
  const [group, setGroup] = useState<GroupSelection>({});
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'payments', page, status, applied, group.groupBy, group.groupKey],
    queryFn: () =>
      api.admin.payments({
        page,
        pageSize: 15,
        ...group,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  const columns: Column<AdminPaymentRow>[] = [
    {
      key: 'sale',
      header: 'Payment',
      render: (p) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{p.eventTitle}</p>
          <p className="text-caption text-text-secondary">{p.buyerEmail}</p>
          <p className="font-mono text-caption text-text-muted">
            {p.bookingReference ?? 'no booking reference'}
          </p>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      className: 'whitespace-nowrap tabular-nums',
      render: (p) => money(p.amountMinor, p.currency),
      sortable: true,
      sortValue: (p) => p.amountMinor,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (p) => (
        <div className="space-y-1">
          <StatusBadge status={p.status} />
          <p className="text-caption text-text-muted">
            {/* Which provider took it, and what they call it - the pair you quote when chasing one. */}
            {p.provider}
            {p.providerRef ? ' · ' : ''}
            <span className="font-mono">{p.providerRef ?? ''}</span>
          </p>
          <p className="text-caption text-text-muted">{dateTime(p.createdAt)}</p>
        </div>
      ),
      sortable: true,
      sortValue: (p) => p.createdAt,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Every charge the platform has taken. No card details are ever stored."
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
            placeholder="Search buyer email, booking reference or provider reference"
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
                {s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card
        title="Payments"
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <GroupedSummary
          resource="payments"
          options={['country', 'organizer', 'event']}
          value={group}
          status={status || undefined}
          q={applied || undefined}
          onChange={(next) => {
            // Page 1: the page number belonged to the previous scope, and page 4 of a group with
            // two rows is an empty table that looks like "no results".
            setGroup(next);
            setPage(1);
          }}
        />
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title="No payment matches"
              hint="A provider reference works here too, if you are chasing one charge."
            />
          }
          rowKey={(p) => p.id}
          onRowClick={(p) => router.push(`/admin/bookings/${p.bookingId}`)}
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
