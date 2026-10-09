'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  StatusBadge,
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
import { AccountContact } from '../../../components/account-contact';
import {
  CurrencyTotals,
  FilterBar,
  apiFilters,
  useFilterDescription,
  useUrlFilters,
} from '../../../components/list-filters';

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
// Every value of the payment's lifecycle, in the order a payment moves through them. AUTHORIZED
// and VOIDED were missing, so an authorised-not-captured charge could not be filtered for at all.
const STATUSES = [
  'REQUIRES_PAYMENT',
  'PROCESSING',
  'AUTHORIZED',
  'SUCCEEDED',
  'FAILED',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
];

const FILTER_KEYS = ['country', 'organizationId', 'eventId', 'status', 'from', 'to', 'q'] as const;

export default function AdminPayments() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<GroupSelection>({});
  const filters = useUrlFilters(FILTER_KEYS);
  const { status, q: applied } = filters.values;
  const [q, setQ] = useState(applied);
  const scope = apiFilters(filters.values);
  const described = useFilterDescription(filters.values, undefined, applied);

  // Page 1 whenever a filter changes: page 4 of a narrower list is an empty table that looks
  // like "no results".
  useEffect(() => setPage(1), [filters.signature]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'payments', page, filters.signature, group.groupBy, group.groupKey],
    enabled: !filters.invalidWindow,
    queryFn: () =>
      api.admin.payments({
        page,
        pageSize: 15,
        ...group,
        ...scope,
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
          <p>
            <AccountContact email={p.buyerEmail} />
          </p>
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
        <div className="space-y-4">
          <SearchInput
            value={q}
            onChange={setQ}
            onSubmit={() => filters.set({ q: q.trim() })}
            placeholder="Search buyer email, booking reference or provider reference"
          />
          <FilterBar
            filters={{
              ...filters,
              clear: () => {
                setQ('');
                filters.clear();
              },
            }}
            statuses={STATUSES}
            countryHint="Where the event took place."
          />
        </div>
      </Card>

      <Card
        title="Payments"
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <div className="mb-3">
          <CurrencyTotals
            resource="payments"
            status={status || undefined}
            q={applied || undefined}
            filters={scope}
            enabled={!filters.invalidWindow}
          />
        </div>
        <GroupedSummary
          resource="payments"
          options={['country', 'organizer', 'event', 'currency']}
          value={group}
          status={status || undefined}
          q={applied || undefined}
          filters={scope}
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
              hint={
                described
                  ? `Nothing matches ${described}.`
                  : 'A provider reference works here too, if you are chasing one charge.'
              }
              action={
                filters.active ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQ('');
                      filters.clear();
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
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
