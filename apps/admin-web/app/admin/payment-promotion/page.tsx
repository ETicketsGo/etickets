'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowRight, CheckCircle2, XCircle } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Select,
  PageHeader,
  Skeleton,
  useToast,
  errorMessage,
  type BadgeTone,
  type Column,
  type PaymentEnvValue,
  type PromotionReportResult,
  type PromotionRequestRow,
  type PromotionStatusValue,
} from '@eticketsgo/web-kit';

const TARGETS: PaymentEnvValue[] = ['QA', 'UAT', 'STAGING', 'PRODUCTION'];
const SOURCE: Record<string, PaymentEnvValue> = {
  QA: 'DEV',
  UAT: 'QA',
  STAGING: 'UAT',
  PRODUCTION: 'STAGING',
};
const PROVIDERS = ['stripe', 'razorpay', 'paypal', 'square'];

const STATUS_TONE: Record<PromotionStatusValue, BadgeTone> = {
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  APPLIED: 'success',
  REJECTED: 'error',
};

export default function PaymentPromotionPage() {
  const qc = useQueryClient();
  const { push } = useToast();
  const [toEnv, setToEnv] = useState<PaymentEnvValue>('PRODUCTION');
  const [provider, setProvider] = useState('stripe');
  const [preview, setPreview] = useState<PromotionReportResult | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'promotion'],
    queryFn: () => api.admin.promotion.list(),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'promotion'] });

  const previewReport = useMutation({
    mutationFn: () => api.admin.promotion.report(SOURCE[toEnv], toEnv, provider),
    onSuccess: setPreview,
    onError: (e) => push(errorMessage(e), 'error'),
  });
  const createReq = useMutation({
    mutationFn: () => api.admin.promotion.create(SOURCE[toEnv], toEnv, provider),
    onSuccess: () => {
      push('Promotion requested', 'success');
      setPreview(null);
      void invalidate();
    },
    onError: (e) => push(errorMessage(e), 'error'),
  });
  const act = (fn: () => Promise<unknown>, ok: string) =>
    fn()
      .then(() => {
        push(ok, 'success');
        void invalidate();
      })
      .catch((e) => push(errorMessage(e), 'error'));

  const columns: Column<PromotionRequestRow>[] = [
    {
      key: 'path',
      header: 'Promotion',
      render: (r) => (
        <span className="flex items-center gap-1">
          {r.fromEnv} <ArrowRight className="h-3 w-3" /> {r.toEnv}
        </span>
      ),
    },
    { key: 'provider', header: 'Provider', render: (r) => <strong>{r.provider}</strong> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
    },
    {
      key: 'approvals',
      header: 'Approvals',
      render: (r) => `${r.approvals.length}/${r.requiredApprovals}`,
    },
    {
      key: 'ok',
      header: 'Valid',
      render: (r) =>
        r.report.ok ? (
          <CheckCircle2 className="h-4 w-4 text-status-success" />
        ) : (
          <XCircle className="h-4 w-4 text-status-error" />
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-2">
          {r.status === 'PENDING_APPROVAL' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act(() => api.admin.promotion.approve(r.id), 'Approved')}
            >
              Approve
            </Button>
          )}
          {r.status === 'APPROVED' && (
            <Button size="sm" onClick={() => act(() => api.admin.promotion.apply(r.id), 'Applied')}>
              Apply
            </Button>
          )}
          {(r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                act(() => api.admin.promotion.reject(r.id, 'admin reject'), 'Rejected')
              }
            >
              Reject
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Environment promotion"
        description="Promote a validated provider config DEV → QA → UAT → STAGING → PRODUCTION. Never a blind copy; two approvals for production."
      />

      <Card title="Request a promotion">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Target environment"
            value={toEnv}
            onChange={(e) => setToEnv(e.target.value as PaymentEnvValue)}
            className="w-44"
          >
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {SOURCE[t]} → {t}
              </option>
            ))}
          </Select>
          <Select
            label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-40"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            onClick={() => previewReport.mutate()}
            loading={previewReport.isPending}
          >
            Preview report
          </Button>
        </div>
      </Card>

      <Card title="Promotion requests">
        <DataTable
          columns={columns}
          rows={list.data}
          loading={list.isLoading}
          rowKey={(r) => r.id}
        />
      </Card>

      {preview && (
        <Dialog
          open
          onClose={() => setPreview(null)}
          title={`Report: ${preview.fromEnv} → ${preview.toEnv} (${preview.provider})`}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Close
              </Button>
              <Button onClick={() => createReq.mutate()} loading={createReq.isPending}>
                Request promotion
              </Button>
            </div>
          }
        >
          {!preview ? (
            <Skeleton className="h-40" />
          ) : (
            <div className="space-y-2">
              <Badge tone={preview.ok ? 'success' : 'error'}>
                {preview.ok ? 'READY' : 'BLOCKED'}
              </Badge>
              <ul className="space-y-1 text-sm">
                {preview.checks.map((c) => (
                  <li key={c.key} className="flex items-center gap-2">
                    {c.passed ? (
                      <CheckCircle2 className="h-4 w-4 text-status-success" />
                    ) : (
                      <XCircle className="h-4 w-4 text-status-error" />
                    )}
                    <span className={c.passed ? '' : 'text-status-error'}>{c.label}</span>
                    {!c.blocking && <span className="text-xs text-text-muted">(optional)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
