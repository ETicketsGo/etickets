'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  api,
  Button,
  DataTable,
  Dialog,
  StatusBadge,
  Select,
  Pagination,
  PageHeader,
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

export default function AdminSettlements() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'settlements', page, status],
    queryFn: () =>
      api.admin.settlements.list({
        page,
        pageSize: PAGE_SIZE,
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
      <div className="grid gap-3 sm:grid-cols-[200px]">
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
        error={isError ? "We couldn't load settlements. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No settlements match these filters" />}
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
