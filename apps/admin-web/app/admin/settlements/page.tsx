'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  Button,
  DataTable,
  Dialog,
  StatusBadge,
  Pagination,
  PageHeader,
  GroupedSummary,
  type GroupSelection,
  EmptyState,
  Skeleton,
  ErrorState,
  Textarea,
  money,
  dateTime,
  useToast,
  errorMessage,
  type Column,
  type SettlementRow,
} from '@eticketsgo/web-kit';
import {
  CurrencyTotals,
  FilterBar,
  apiFilters,
  useFilterDescription,
  useUrlFilters,
} from '../../../components/list-filters';

const STATUSES = [
  'PENDING',
  'HELD',
  'ELIGIBLE',
  'APPROVED',
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'BLOCKED',
  'FAILED',
  'REVERSED',
];

const PAGE_SIZE = 15;
const FILTER_KEYS = ['country', 'organizationId', 'eventId', 'status', 'from', 'to'] as const;

export default function AdminSettlements() {
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<GroupSelection>({});
  /*
    The status this page opens on can be named in the link.

    The action centre on the landing page counts each queue and links straight to it. Those
    links were landing on an UNFILTERED list, so "2 settlements blocked" took an operator to a
    page where they had to find those rows again - which is the work the count existed to
    save. The same failing as the search boxes that only ever searched the page you were on.

    Every filter now lives in the URL, so that link is simply the status filter.

    Read-only: these choose which settlements are listed. Nothing here changes a settlement's
    money or state; approve, release and block stay in the dialog, unchanged.
  */
  const filters = useUrlFilters(FILTER_KEYS);
  const { status } = filters.values;
  const scope = apiFilters(filters.values);
  const described = useFilterDescription(filters.values);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => setPage(1), [filters.signature]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'settlements', page, filters.signature, group.groupBy, group.groupKey],
    enabled: !filters.invalidWindow,
    queryFn: () =>
      api.admin.settlements.list({
        page,
        pageSize: PAGE_SIZE,
        ...group,
        ...scope,
        status: status || undefined,
      }),
  });

  const columns: Column<SettlementRow>[] = [
    {
      key: 'organization',
      header: 'Organizer',
      render: (s) => s.organization?.name ?? s.organizationId.slice(0, 8),
    },
    {
      key: 'event',
      header: 'Event',
      render: (s) => s.event?.title ?? s.eventId.slice(0, 8),
    },
    {
      key: 'gross',
      header: 'Gross',
      render: (s) => money(s.grossSalesMinor, s.currency),
      sortable: true,
      sortValue: (s) => s.grossSalesMinor,
    },
    {
      key: 'refunds',
      header: 'Refunds',
      render: (s) => money(s.refundsMinor, s.currency),
    },
    {
      key: 'payable',
      header: 'Payable',
      render: (s) => <span className="font-semibold">{money(s.payableMinor, s.currency)}</span>,
      sortable: true,
      sortValue: (s) => s.payableMinor,
    },
    {
      key: 'transferred',
      header: 'Transferred',
      render: (s) => money(s.transferredMinor, s.currency),
    },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'created', header: 'Created', render: (s) => dateTime(s.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settlements"
        description="Marketplace payout ledger. Review, approve, release, or block organizer settlements."
      />
      <div className="rounded-lg border border-border bg-background-surface p-4">
        <FilterBar
          filters={filters}
          statuses={STATUSES}
          countryHint="Where the event took place. Dates are when the settlement was created."
        />
      </div>

      <CurrencyTotals
        resource="settlements"
        status={status || undefined}
        filters={scope}
        enabled={!filters.invalidWindow}
      />

      <GroupedSummary
        resource="settlements"
        options={['country', 'organizer', 'event', 'currency']}
        value={group}
        status={status || undefined}
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
        error={isError ? "We couldn't load settlements. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={
          <EmptyState
            title="No settlements match these filters"
            hint={described ? `Nothing matches ${described}.` : undefined}
            action={
              filters.active ? (
                <Button variant="outline" onClick={filters.clear}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
        rowKey={(s) => s.id}
        onRowClick={(s) => setSelectedId(s.id)}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}

      {selectedId && <SettlementDetailDialog id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function LedgerRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className={strong ? 'font-semibold text-text-primary' : 'text-text-primary'}>
        {value}
      </span>
    </div>
  );
}

type PendingAction = 'release' | 'block' | null;

function SettlementDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<PendingAction>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const {
    data: detail,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'settlement', id],
    queryFn: () => api.admin.settlements.get(id),
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'settlements'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'settlement', id] });
  };

  const resetAction = () => {
    setAction(null);
    setNote('');
    setReason('');
  };

  const approve = useMutation({
    mutationFn: () => api.admin.settlements.approve(id),
    onSuccess: () => {
      toast.push('Settlement approved.', 'success');
      refreshAll();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const release = useMutation({
    mutationFn: () => api.admin.settlements.release(id, note.trim() || undefined),
    onSuccess: () => {
      toast.push('Settlement released for transfer.', 'success');
      resetAction();
      refreshAll();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const block = useMutation({
    mutationFn: () => api.admin.settlements.block(id, reason.trim()),
    onSuccess: () => {
      toast.push('Settlement blocked.', 'success');
      resetAction();
      refreshAll();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const busy = approve.isPending || release.isPending || block.isPending;

  const title =
    action === 'release'
      ? 'Release settlement?'
      : action === 'block'
        ? 'Block settlement?'
        : 'Settlement details';

  // Footer differs between the detail view and a confirm step.
  let footer: ReactNode = null;
  if (action === 'release') {
    footer = (
      <>
        <Button variant="secondary" onClick={resetAction} disabled={release.isPending}>
          Back
        </Button>
        <Button loading={release.isPending} onClick={() => release.mutate()}>
          Confirm release
        </Button>
      </>
    );
  } else if (action === 'block') {
    footer = (
      <>
        <Button variant="secondary" onClick={resetAction} disabled={block.isPending}>
          Back
        </Button>
        <Button
          variant="danger"
          loading={block.isPending}
          disabled={!reason.trim()}
          onClick={() => block.mutate()}
        >
          Confirm block
        </Button>
      </>
    );
  } else if (detail) {
    const canApprove = detail.status === 'ELIGIBLE';
    const canRelease = detail.status === 'APPROVED';
    const canBlock = ['PENDING', 'HELD', 'ELIGIBLE', 'APPROVED'].includes(detail.status);
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {canBlock && (
          <Button variant="danger" onClick={() => setAction('block')} disabled={busy}>
            Block
          </Button>
        )}
        {canApprove && (
          <Button onClick={() => approve.mutate()} loading={approve.isPending}>
            Approve
          </Button>
        )}
        {canRelease && (
          <Button onClick={() => setAction('release')} disabled={busy}>
            Release
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog open onClose={onClose} title={title} footer={footer}>
      {isLoading || (!detail && !isError) ? (
        <Skeleton className="h-48" />
      ) : isError || !detail ? (
        <ErrorState
          message="We couldn't load this settlement. Please try again."
          onRetry={() => refetch()}
        />
      ) : action === 'release' ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            This releases <strong>{money(detail.payableMinor, detail.currency)}</strong> to{' '}
            {detail.organization?.name ?? 'the organizer'} for transfer to their connected account.
          </p>
          <Textarea
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Add an internal note for the audit trail…"
          />
        </div>
      ) : action === 'block' ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Blocking holds this settlement and prevents any transfer. A reason is required for the
            audit trail.
          </p>
          <Textarea
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required
            placeholder="Why is this settlement being blocked?"
          />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-text-primary">{detail.event?.title ?? 'Event'}</p>
              <p className="text-caption text-text-muted">
                {detail.organization?.name ?? detail.organizationId}
              </p>
            </div>
            <StatusBadge status={detail.status} />
          </div>

          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
              Ledger
            </div>
            <div className="divide-y divide-border px-4">
              <LedgerRow
                label="Gross sales"
                value={money(detail.grossSalesMinor, detail.currency)}
              />
              <LedgerRow label="Refunds" value={money(detail.refundsMinor, detail.currency)} />
              <LedgerRow label="Disputes" value={money(detail.disputesMinor, detail.currency)} />
              <LedgerRow
                label="Platform fees"
                value={money(detail.platformFeesMinor, detail.currency)}
              />
              <LedgerRow label="Reserve" value={money(detail.reserveMinor, detail.currency)} />
              <LedgerRow
                label="Payable"
                value={money(detail.payableMinor, detail.currency)}
                strong
              />
              <LedgerRow
                label="Transferred"
                value={money(detail.transferredMinor, detail.currency)}
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-secondary">Provider transfer</dt>
            <dd className="text-right font-mono text-caption text-text-primary">
              {detail.providerTransferId ?? '—'}
            </dd>
            <dt className="text-text-secondary">Released</dt>
            <dd className="text-right text-text-primary">
              {detail.releasedAt ? dateTime(detail.releasedAt) : '—'}
            </dd>
            <dt className="text-text-secondary">Created</dt>
            <dd className="text-right text-text-primary">{dateTime(detail.createdAt)}</dd>
          </dl>

          <div>
            <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
              Linked payments ({detail.payments.length})
            </p>
            {detail.payments.length === 0 ? (
              <p className="text-sm text-text-muted">No payments linked to this settlement.</p>
            ) : (
              <ul className="space-y-2">
                {detail.payments.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-caption text-text-muted">
                      {p.id.slice(0, 12)}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-text-secondary">
                        net {money(p.organizerNetMinor, detail.currency)}
                      </span>
                      <span className="text-text-primary">
                        {money(p.amountMinor, detail.currency)}
                      </span>
                      <StatusBadge status={p.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
