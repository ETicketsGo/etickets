'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  MetricCard,
  PageHeader,
  money,
  tokenStore,
  useToast,
  errorMessage,
  type BadgeTone,
  type Column,
  type DiscrepancyRow,
  type DiscrepancyStatusValue,
} from '@eticketsgo/web-kit';

/*
  The queue is read by a finance person, not by the code that files the rows, so the row says
  what happened rather than naming the constant. An unknown type still falls back to its raw
  name - a new detector must be legible on the day it ships, not on the day somebody adds it
  to this list.
*/
const TYPE_LABELS: Record<string, string> = {
  PAYMENT_MISSING_INTERNALLY: 'Payment we have no record of',
  PAYMENT_MISSING_AT_PROVIDER: 'Payment the provider has no record of',
  AMOUNT_MISMATCH: 'Amount does not match',
  CURRENCY_MISMATCH: 'Currency does not match',
  DUPLICATE_CAPTURE: 'Charged twice',
  REFUND_MISMATCH: 'Refund does not match',
  CHARGEBACK: 'Chargeback',
  SETTLEMENT_MISMATCH: 'Settlement does not match',
  GATEWAY_FEE_MISMATCH: 'Provider fee does not match',
  ORGANIZER_PAYABLE_MISMATCH: 'Organizer amount does not match',
};

const STATUS_LABELS: Record<DiscrepancyStatusValue, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Being looked at',
  RESOLVED: 'Resolved',
  IGNORED: 'Ignored',
};

const STATUS_TONE: Record<DiscrepancyStatusValue, BadgeTone> = {
  OPEN: 'error',
  ASSIGNED: 'warning',
  RESOLVED: 'success',
  IGNORED: 'neutral',
};

function downloadCsv() {
  fetch(api.admin.finance.csvUrl(), {
    headers: { authorization: `Bearer ${tokenStore.access ?? ''}` },
  })
    .then((r) => r.text())
    .then((text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'discrepancies.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
}

export default function FinanceReconciliationPage() {
  const qc = useQueryClient();
  const { push } = useToast();
  const list = useQuery({
    queryKey: ['admin', 'discrepancies'],
    queryFn: () => api.admin.finance.discrepancies(),
  });
  const aging = useQuery({
    queryKey: ['admin', 'aging'],
    queryFn: () => api.admin.finance.aging(),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'discrepancies'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'aging'] });
  };
  const detect = useMutation({
    mutationFn: () => api.admin.finance.detect(),
    onSuccess: (r) => {
      push(`Detected ${r.detected}, filed ${r.created}`, 'success');
      invalidate();
    },
    onError: (e) => push(errorMessage(e), 'error'),
  });
  const act = (fn: () => Promise<unknown>, ok: string) =>
    fn()
      .then(() => {
        push(ok, 'success');
        invalidate();
      })
      .catch((e) => push(errorMessage(e), 'error'));

  /*
    ── FOUR COLUMNS, NOT SEVEN ──────────────────────────────────────────────────────
    This queue used to put type, provider, reference, amount, status, the free-text detail
    and two buttons in seven columns side by side. The detail is a sentence, so the table was
    always wider than the screen: the first column was cut in half and reading a row meant
    dragging a horizontal scrollbar back and forth.

    The facts that identify one discrepancy - what kind it is, which provider it came from,
    what it points at, and what is wrong - belong together as one description, stacked. That
    leaves the three things somebody scans down the page for: amount, status, and what to do.
  */
  const columns: Column<DiscrepancyRow>[] = [
    {
      key: 'type',
      header: 'Discrepancy',
      render: (r) => (
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-text-primary">{TYPE_LABELS[r.type] ?? r.type}</p>
          <p className="text-caption text-text-secondary">{r.detail}</p>
          <p className="text-caption text-text-muted">
            {r.provider}
            {r.entityRef ? ` · ${r.entityRef}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      className: 'whitespace-nowrap tabular-nums',
      render: (r) => (r.amountMinor != null ? money(r.amountMinor, r.currency ?? undefined) : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      className: 'whitespace-nowrap',
      render: (r) =>
        r.status === 'OPEN' || r.status === 'ASSIGNED' ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                act(() => api.admin.finance.resolve(r.id, 'resolved by admin'), 'Resolved')
              }
            >
              Resolve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                act(() => api.admin.finance.ignore(r.id, 'ignored by admin'), 'Ignored')
              }
            >
              Ignore
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance reconciliation"
        description="Discrepancy triage queue. Financial records are never auto-corrected — resolution is a human, audited action."
      />

      <div className="flex flex-wrap gap-3">
        <Button onClick={() => detect.mutate()} loading={detect.isPending}>
          <RefreshCw className="h-4 w-4" /> Run detection
        </Button>
        <Button variant="secondary" onClick={downloadCsv}>
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {aging.data?.map((b) => (
          <MetricCard key={b.bucket} label={b.bucket} value={String(b.count)} />
        ))}
      </div>

      <Card title="Discrepancies">
        <DataTable
          columns={columns}
          rows={list.data}
          loading={list.isLoading}
          rowKey={(r) => r.id}
          empty={
            <EmptyState
              title="Nothing to reconcile"
              hint="Everything the last detection run compared agreed. Run detection again to check now."
            />
          }
        />
      </Card>
    </div>
  );
}
