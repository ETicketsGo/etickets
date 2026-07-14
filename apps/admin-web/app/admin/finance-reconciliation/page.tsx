'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
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

  const columns: Column<DiscrepancyRow>[] = [
    { key: 'type', header: 'Type', render: (r) => <strong>{r.type}</strong> },
    { key: 'provider', header: 'Provider', render: (r) => r.provider },
    { key: 'ref', header: 'Reference', render: (r) => r.entityRef },
    {
      key: 'amount',
      header: 'Amount',
      render: (r) => (r.amountMinor != null ? money(r.amountMinor) : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
    },
    { key: 'detail', header: 'Detail', render: (r) => <span className="text-xs">{r.detail}</span> },
    {
      key: 'actions',
      header: '',
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
        />
      </Card>
    </div>
  );
}
