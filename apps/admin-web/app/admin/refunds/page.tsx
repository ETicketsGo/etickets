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
  SearchInput,
  Pagination,
  PageHeader,
  GroupedSummary,
  type GroupSelection,
  EmptyState,
  money,
  dateTime,
  type Column,
  type RefundRow,
} from '@eticketsgo/web-kit';
import { AccountContact } from '../../../components/account-contact';
import { MoneyStatusPill } from '../../../components/money-status';
import { moneyStatusLabel } from '../../../lib/money-status';
import {
  CurrencyTotals,
  FilterBar,
  apiFilters,
  useFilterDescription,
  useUrlFilters,
} from '../../../components/list-filters';

const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED'];
const FILTER_KEYS = ['country', 'organizationId', 'eventId', 'status', 'from', 'to', 'q'] as const;

export default function AdminRefunds() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<GroupSelection>({});
  /*
    The status this page opens on can be named in the link.

    The action centre on the landing page counts each queue and links straight to it. Those
    links were landing on an UNFILTERED list, so "4 refunds that did not go through" took an operator to a
    page where they had to find those rows again - which is the work the count existed to
    save. The same failing as the search boxes that only ever searched the page you were on.

    Every filter now lives in the URL, so that link is simply the status filter. The queue still
    opens on REQUESTED when the link names none; "Every status" is written as `status=`.
  */
  const filters = useUrlFilters(FILTER_KEYS, { status: 'REQUESTED' });
  const { status, q: applied } = filters.values;
  const [q, setQ] = useState(applied);
  const scope = apiFilters(filters.values);
  const described = useFilterDescription(filters.values, undefined, applied);
  const clearAll = () => {
    setQ('');
    filters.clear();
  };

  useEffect(() => setPage(1), [filters.signature]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'refunds', page, filters.signature, group.groupBy, group.groupKey],
    enabled: !filters.invalidWindow,
    queryFn: () =>
      api.admin.refunds({
        page,
        pageSize: 15,
        ...group,
        ...scope,
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
          <p>
            <AccountContact email={r.booking?.buyerEmail} fallback="No buyer" />
          </p>
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
      render: (r) => (
        <span className="font-semibold">{money(r.amountMinor, r.booking?.currency)}</span>
      ),
      sortable: true,
      sortValue: (r) => r.amountMinor,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="space-y-1">
          <MoneyStatusPill entity="refund" status={r.status} />
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
        <div className="space-y-4">
          <SearchInput
            value={q}
            onChange={setQ}
            onSubmit={() => filters.set({ q: q.trim() })}
            placeholder="Search buyer email or booking reference"
          />
          <FilterBar
            filters={{ ...filters, clear: clearAll }}
            statuses={STATUSES}
            statusName={(s) => moneyStatusLabel('refund', s)}
            countryHint="Where the event took place."
          />
        </div>
      </Card>
      <Card
        title={status === 'REQUESTED' ? 'Waiting for a decision' : 'Refunds'}
        action={
          data ? (
            <Badge tone="neutral">{data.meta.total.toLocaleString()} matching</Badge>
          ) : undefined
        }
      >
        <div className="mb-3">
          <CurrencyTotals
            resource="refunds"
            status={status || undefined}
            q={applied || undefined}
            filters={scope}
            enabled={!filters.invalidWindow}
          />
        </div>
        <GroupedSummary
          resource="refunds"
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
          caption="Refunds"
          density="compact"
          mobile="cards"
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title={
                status === 'REQUESTED' && described === 'status Requested'
                  ? 'Nothing waiting for a decision'
                  : 'No refund matches'
              }
              hint={
                described ? `Nothing matches ${described}.` : 'A booking reference works here too.'
              }
              action={
                filters.active ? (
                  <Button variant="outline" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : undefined
              }
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
