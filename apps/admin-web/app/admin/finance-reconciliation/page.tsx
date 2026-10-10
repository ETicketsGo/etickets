'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Timer } from 'lucide-react';
import {
  api,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  StatusPill,
  type PillTone,
  money,
  tokenStore,
  useToast,
  errorMessage,
  type Column,
  type DiscrepancyRow,
  type DiscrepancyStatusValue,
} from '@eticketsgo/web-kit';
import { useUrlFilters } from '../../../components/list-filters';
import { missingDutyNote, useHolds } from '@/lib/capabilities';

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

const STATUS_TONE: Record<DiscrepancyStatusValue, PillTone> = {
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

const STATUS_KEYS = ['status'] as const;

export default function FinanceReconciliationPage() {
  const qc = useQueryClient();
  const { push } = useToast();
  /*
    The status can be named in the link, like every other queue's: the dashboard counts the
    exceptions nobody has picked up and links here with `?status=OPEN`, and landing on the whole
    history instead would make the operator find those rows again. The API already filtered by
    status; this page never asked it to.
  */
  const filters = useUrlFilters(STATUS_KEYS);
  /*
    The queue opens with FINANCE_READ. Running detection and resolving or ignoring a row are
    decisions about money findings, so they need FINANCE_RESOLVE; a reader sees no buttons the
    API would refuse, and one line saying why.
  */
  const mayResolve = useHolds('FINANCE_RESOLVE');
  const status = (filters.values.status || undefined) as DiscrepancyStatusValue | undefined;
  const list = useQuery({
    queryKey: ['admin', 'discrepancies', status ?? 'all'],
    queryFn: () => api.admin.finance.discrepancies(status),
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
      render: (r) => (
        <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</StatusPill>
      ),
    },
    {
      key: 'actions',
      header: '',
      mobileLabel: 'Next step',
      className: 'whitespace-nowrap',
      render: (r) =>
        mayResolve && (r.status === 'OPEN' || r.status === 'ASSIGNED') ? (
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
        description="Discrepancy triage queue. Financial records are never corrected automatically: resolving one is a person's audited decision."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadCsv}>
              <Download className="h-4 w-4" aria-hidden /> Export CSV
            </Button>
            {mayResolve && (
              <Button onClick={() => detect.mutate()} loading={detect.isPending}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Run detection
              </Button>
            )}
          </div>
        }
      />
      {!mayResolve && (
        <p className="text-caption text-text-muted">
          {missingDutyNote('run detection or resolve discrepancies', 'FINANCE_RESOLVE')}
        </p>
      )}

      {/*
        How long the open exceptions have waited, as the API buckets them. Counts only: the aging
        report carries no amounts, and an amount across buckets would add currencies together.
      */}
      <section aria-labelledby="aging-heading" className="space-y-3">
        <h2 id="aging-heading" className="font-display text-title font-bold text-text-primary">
          How long they have waited
        </h2>
        {aging.isLoading ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {aging.data?.map((b, i) => (
              <StatCard
                key={b.bucket}
                label={b.bucket}
                value={b.count.toLocaleString()}
                icon={Timer}
                // Older buckets warm up: the longer an exception waits, the more it needs somebody.
                tile={i === 0 ? 'teal' : i === 1 ? 'blue' : i === 2 ? 'purple' : 'amber'}
              />
            ))}
          </div>
        )}
      </section>

      <Card
        title="Discrepancies"
        action={
          <div className="w-48">
            <Select
              aria-label="Status filter"
              value={status ?? ''}
              onChange={(e) => filters.set({ status: e.target.value || undefined })}
            >
              <option value="">Every status</option>
              {(Object.keys(STATUS_LABELS) as DiscrepancyStatusValue[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        <DataTable
          caption="Discrepancies"
          density="compact"
          mobile="cards"
          columns={columns}
          rows={list.data}
          loading={list.isLoading}
          rowKey={(r) => r.id}
          empty={
            status ? (
              <EmptyState
                title={`No discrepancy is ${STATUS_LABELS[status].toLowerCase()}`}
                hint="Choose Every status to see the whole history."
              />
            ) : (
              <EmptyState
                title="Nothing to reconcile"
                hint={
                  mayResolve
                    ? 'Everything the last detection run compared agreed. Run detection again to check now.'
                    : 'Everything the last detection run compared agreed.'
                }
              />
            )
          }
        />
      </Card>
    </div>
  );
}
