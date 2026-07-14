'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckCircle2, Circle, Plus, PlugZap } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Input,
  Select,
  PageHeader,
  Skeleton,
  useToast,
  errorMessage,
  type BadgeTone,
  type Column,
  type CreateOnboardingBody,
  type MerchantOnboardingRow,
  type OnboardingStatusValue,
  type PaymentEnvValue,
} from '@eticketsgo/web-kit';

const ENVS: PaymentEnvValue[] = ['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION'];
const PROVIDERS = ['stripe', 'razorpay', 'paypal', 'square'];

const STATUS_TONE: Record<OnboardingStatusValue, BadgeTone> = {
  DRAFT: 'neutral',
  PENDING_CONFIGURATION: 'info',
  PENDING_VERIFICATION: 'info',
  TESTING: 'warning',
  READY_FOR_LIVE: 'warning',
  ACTIVE: 'success',
  SUSPENDED: 'error',
  REJECTED: 'error',
};

const NEXT: Partial<Record<OnboardingStatusValue, OnboardingStatusValue>> = {
  DRAFT: 'PENDING_CONFIGURATION',
  PENDING_CONFIGURATION: 'PENDING_VERIFICATION',
  PENDING_VERIFICATION: 'TESTING',
  TESTING: 'READY_FOR_LIVE',
};

export default function MerchantOnboardingPage() {
  const [env, setEnv] = useState<PaymentEnvValue>('UAT');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { push } = useToast();

  const list = useQuery({
    queryKey: ['admin', 'onboarding', env],
    queryFn: () => api.admin.onboarding.list(env),
  });

  const columns: Column<MerchantOnboardingRow>[] = [
    { key: 'name', header: 'Merchant', render: (r) => <strong>{r.displayName}</strong> },
    { key: 'country', header: 'Country', render: (r) => `${r.country} / ${r.settlementCurrency}` },
    { key: 'provider', header: 'Provider', render: (r) => r.provider },
    { key: 'mode', header: 'Mode', render: (r) => r.mode },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => setSelected(r.id)}>
          Open
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Merchant onboarding"
        description="Onboard and activate real merchants per environment. Secret references only — never bank credentials."
      />
      <div className="flex items-center gap-3">
        <Select
          label="Environment"
          value={env}
          onChange={(e) => setEnv(e.target.value as PaymentEnvValue)}
          className="w-48"
        >
          {ENVS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
        <Button className="mt-6" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New merchant
        </Button>
      </div>

      <Card title="Merchants">
        <DataTable
          columns={columns}
          rows={list.data}
          loading={list.isLoading}
          rowKey={(r) => r.id}
        />
      </Card>

      {creating && (
        <CreateDialog
          env={env}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void list.refetch();
            push('Merchant created', 'success');
          }}
        />
      )}
      {selected && <DetailDialog id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CreateDialog({
  env,
  onClose,
  onCreated,
}: {
  env: PaymentEnvValue;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { push } = useToast();
  const [form, setForm] = useState<CreateOnboardingBody>({
    env,
    country: '',
    legalBusinessName: '',
    displayName: '',
    settlementCurrency: '',
    provider: 'stripe',
    mode: 'TEST',
  });
  const create = useMutation({
    mutationFn: () => api.admin.onboarding.create(form),
    onSuccess: onCreated,
    onError: (e) => push(errorMessage(e), 'error'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`New merchant (${env})`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending}>
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Input
          label="Legal business name"
          value={form.legalBusinessName}
          onChange={(e) => setForm({ ...form, legalBusinessName: e.target.value })}
        />
        <Input
          label="Display name"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Country (ISO-2)"
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
          />
          <Input
            label="Settlement currency"
            value={form.settlementCurrency}
            onChange={(e) => setForm({ ...form, settlementCurrency: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Provider"
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value })}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Select
            label="Mode"
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value as 'TEST' | 'LIVE' })}
          >
            <option value="TEST">TEST</option>
            <option value="LIVE">LIVE</option>
          </Select>
        </div>
      </div>
    </Dialog>
  );
}

function DetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { push } = useToast();
  const detail = useQuery({
    queryKey: ['admin', 'onboarding-detail', id],
    queryFn: () => api.admin.onboarding.detail(id),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'onboarding-detail', id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] });
  };
  const run = (fn: () => Promise<unknown>, ok: string) =>
    fn()
      .then(() => {
        push(ok, 'success');
        invalidate();
      })
      .catch((e) => push(errorMessage(e), 'error'));

  const data = detail.data;
  const record = data?.record;
  const [refs, setRefs] = useState<{ [k: string]: string }>({});
  const field = (k: string, current: string | null | undefined) => refs[k] ?? current ?? '';

  return (
    <Dialog open onClose={onClose} title={record ? record.displayName : 'Merchant'}>
      {detail.isLoading || !data || !record ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <Badge tone={STATUS_TONE[record.status]}>{record.status}</Badge>
            <span className="text-text-muted">
              {record.env} · {record.provider} · {record.country}/{record.settlementCurrency}
            </span>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-text-muted">Activation checklist</p>
            <ul className="space-y-1 text-sm">
              {data.checklist.map((item) => (
                <li key={item.key} className="flex items-center gap-2">
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4 text-status-success" />
                  ) : (
                    <Circle className="h-4 w-4 text-text-muted" />
                  )}
                  <span className={item.done ? '' : 'text-text-secondary'}>{item.label}</span>
                  {!item.blocking && <span className="text-xs text-text-muted">(optional)</span>}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Account identifier"
              value={field('accountIdentifier', record.accountIdentifier)}
              onChange={(e) => setRefs({ ...refs, accountIdentifier: e.target.value })}
            />
            <Input
              label="Public key"
              value={field('publicKey', record.publicKey)}
              onChange={(e) => setRefs({ ...refs, publicKey: e.target.value })}
            />
            <Input
              label="Secret key ref"
              value={field('secretKeyRef', record.secretKeyRef)}
              onChange={(e) => setRefs({ ...refs, secretKeyRef: e.target.value })}
            />
            <Input
              label="Webhook secret ref"
              value={field('webhookSecretRef', record.webhookSecretRef)}
              onChange={(e) => setRefs({ ...refs, webhookSecretRef: e.target.value })}
            />
            <Input
              label="Payout destination ref"
              value={field('payoutDestinationRef', record.payoutDestinationRef)}
              onChange={(e) => setRefs({ ...refs, payoutDestinationRef: e.target.value })}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => run(() => api.admin.onboarding.update(id, refs), 'Saved')}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => run(() => api.admin.onboarding.acceptTerms(id), 'Terms accepted')}
            >
              Accept terms
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                run(() => api.admin.onboarding.setWebhookStatus(id, 'VERIFIED'), 'Webhook verified')
              }
            >
              Webhook verified
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                run(() => api.admin.onboarding.setVerification(id, 'VERIFIED'), 'Verified')
              }
            >
              Mark verified
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                api.admin.onboarding
                  .testConnection(id)
                  .then((r) =>
                    push(
                      r.healthy ? `Healthy (${r.mode ?? ''})` : `Unhealthy: ${r.message}`,
                      r.healthy ? 'success' : 'error',
                    ),
                  )
                  .catch((e) => push(errorMessage(e), 'error'))
              }
            >
              <PlugZap className="h-4 w-4" /> Test connection
            </Button>
            {NEXT[record.status] && (
              <Button
                size="sm"
                onClick={() =>
                  run(() => api.admin.onboarding.transition(id, NEXT[record.status]!), 'Advanced')
                }
              >
                Advance → {NEXT[record.status]}
              </Button>
            )}
            {record.status === 'READY_FOR_LIVE' && (
              <Button
                size="sm"
                onClick={() => run(() => api.admin.onboarding.activate(id), 'Activated')}
              >
                Activate
              </Button>
            )}
            {record.status === 'ACTIVE' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  run(() => api.admin.onboarding.suspend(id, 'admin suspend'), 'Suspended')
                }
              >
                Suspend
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
