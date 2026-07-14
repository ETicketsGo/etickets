'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, PlugZap, Plus, Trash2, XCircle } from 'lucide-react';
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
  ErrorState,
  Skeleton,
  useToast,
  errorMessage,
  money,
  type BadgeTone,
  type Column,
  type PaymentConfigOverview,
  type PaymentEnvValue,
  type PaymentProviderConfigRow,
  type PaymentProviderModeValue,
  type PaymentRouteRow,
  type ProviderHealthRow,
  type SettlementLine,
} from '@eticketsgo/web-kit';

const ENVS: PaymentEnvValue[] = ['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION'];
const MODES: PaymentProviderModeValue[] = ['DUMMY', 'TEST', 'LIVE'];

function modeTone(mode: PaymentProviderModeValue): BadgeTone {
  if (mode === 'LIVE') return 'success';
  if (mode === 'TEST') return 'info';
  return 'neutral';
}

export default function PaymentConfigPage() {
  const [env, setEnv] = useState<PaymentEnvValue>('LOCAL');
  const qc = useQueryClient();
  const { push } = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'payment-config', env],
    queryFn: () => api.admin.paymentConfig.overview(env),
  });

  const [editing, setEditing] = useState<PaymentProviderConfigRow | null>(null);
  const [routeEditing, setRouteEditing] = useState<PaymentRouteRow | 'new' | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'payment-config', env] });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.admin.paymentConfig.testConnection(id, env),
    onSuccess: (r) =>
      push(
        r.healthy
          ? `Healthy${r.mode ? ` (${r.mode})` : ''}`
          : `Unhealthy: ${r.message ?? 'failed'}`,
        r.healthy ? 'success' : 'error',
      ),
    onError: (e) => push(errorMessage(e), 'error'),
  });

  const deleteRoute = useMutation({
    mutationFn: (id: string) => api.admin.paymentConfig.deleteRoute(id, env),
    onSuccess: () => {
      push('Route deleted', 'success');
      void invalidate();
    },
    onError: (e) => push(errorMessage(e), 'error'),
  });

  if (error) {
    return <ErrorState message={`Could not load payment configuration: ${errorMessage(error)}`} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payment configuration"
        description="Runtime multi-provider payment settings per environment. Secrets are stored as references only."
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
              {data?.activeEnv === e ? ' (active)' : ''}
            </option>
          ))}
        </Select>
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <ValidationBanner data={data} />

          <Card
            title="Providers"
            action={
              <span className="text-xs text-text-muted">
                Enable a real provider only with valid credentials — production fails closed.
              </span>
            }
          >
            <ProvidersTable
              rows={data.providers}
              onEdit={setEditing}
              onTest={(id) => testMutation.mutate(id)}
              testingId={testMutation.isPending ? testMutation.variables : undefined}
            />
          </Card>

          <Card
            title="Routing"
            action={
              <Button size="sm" variant="secondary" onClick={() => setRouteEditing('new')}>
                <Plus className="h-4 w-4" /> Add route
              </Button>
            }
          >
            <RoutesTable
              rows={data.routes}
              onEdit={setRouteEditing}
              onDelete={(id) => deleteRoute.mutate(id)}
            />
          </Card>

          <OperationsSection />
        </>
      )}

      {editing && (
        <ProviderDialog
          env={env}
          config={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      )}
      {routeEditing && (
        <RouteDialog
          env={env}
          route={routeEditing === 'new' ? null : routeEditing}
          onClose={() => setRouteEditing(null)}
          onSaved={() => {
            setRouteEditing(null);
            void invalidate();
          }}
        />
      )}
    </div>
  );
}

function ValidationBanner({ data }: { data: PaymentConfigOverview }) {
  const { validation } = data;
  if (validation.ok && validation.issues.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-status-success/30 bg-status-success/8 px-4 py-3 text-sm text-status-success">
        <CheckCircle2 className="h-4 w-4" /> Configuration is valid for {data.env}.
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-status-warning/30 bg-status-warning/8 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-status-warning">
        <AlertTriangle className="h-4 w-4" />
        {validation.ok ? 'Warnings' : 'Configuration is invalid'} for {data.env}
      </div>
      <ul className="space-y-1 text-xs text-text-secondary">
        {validation.issues.map((issue, i) => (
          <li key={i}>
            <Badge tone={issue.severity === 'ERROR' ? 'error' : 'warning'}>{issue.severity}</Badge>{' '}
            {issue.provider ? <strong>{issue.provider}: </strong> : null}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProvidersTable({
  rows,
  onEdit,
  onTest,
  testingId,
}: {
  rows: PaymentProviderConfigRow[];
  onEdit: (r: PaymentProviderConfigRow) => void;
  onTest: (id: string) => void;
  testingId?: string;
}) {
  const columns: Column<PaymentProviderConfigRow>[] = [
    { key: 'provider', header: 'Provider', render: (r) => <strong>{r.provider}</strong> },
    {
      key: 'enabled',
      header: 'Enabled',
      render: (r) => (
        <Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
      ),
    },
    { key: 'mode', header: 'Mode', render: (r) => <Badge tone={modeTone(r.mode)}>{r.mode}</Badge> },
    { key: 'publicKey', header: 'Public key', render: (r) => r.publicKey ?? '—' },
    { key: 'secretKeyRef', header: 'Secret ref', render: (r) => r.secretKeyRef ?? '—' },
    { key: 'priority', header: 'Priority', render: (r) => r.priority },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onTest(r.id)}
            loading={testingId === r.id}
          >
            <PlugZap className="h-4 w-4" /> Test
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onEdit(r)}>
            Edit
          </Button>
        </div>
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

function RoutesTable({
  rows,
  onEdit,
  onDelete,
}: {
  rows: PaymentRouteRow[];
  onEdit: (r: PaymentRouteRow) => void;
  onDelete: (id: string) => void;
}) {
  const columns: Column<PaymentRouteRow>[] = [
    {
      key: 'match',
      header: 'Country / Currency / Method',
      render: (r) => `${r.country} / ${r.currency} / ${r.method}`,
    },
    { key: 'provider', header: 'Provider', render: (r) => <strong>{r.provider}</strong> },
    { key: 'failover', header: 'Failover', render: (r) => r.failoverProvider ?? '—' },
    { key: 'priority', header: 'Priority', render: (r) => r.priority },
    {
      key: 'active',
      header: 'Active',
      render: (r) => (
        <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Yes' : 'No'}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => onEdit(r)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDelete(r.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

function ProviderDialog({
  env,
  config,
  onClose,
  onSaved,
}: {
  env: PaymentEnvValue;
  config: PaymentProviderConfigRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [form, setForm] = useState({
    enabled: config.enabled,
    mode: config.mode,
    publicKey: config.publicKey ?? '',
    secretKeyRef: config.secretKeyRef ?? '',
    webhookSecretRef: config.webhookSecretRef ?? '',
    apiBaseUrl: config.apiBaseUrl ?? '',
    priority: config.priority,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  const save = useMutation({
    mutationFn: () =>
      api.admin.paymentConfig.updateProvider(
        config.id,
        {
          enabled: form.enabled,
          mode: form.mode,
          publicKey: form.publicKey || null,
          secretKeyRef: form.secretKeyRef || null,
          webhookSecretRef: form.webhookSecretRef || null,
          apiBaseUrl: form.apiBaseUrl || null,
          priority: Number(form.priority),
          timeoutMs: Number(form.timeoutMs),
          maxRetries: Number(form.maxRetries),
        },
        env,
      ),
    onSuccess: () => {
      push('Provider updated', 'success');
      onSaved();
    },
    onError: (e) => push(errorMessage(e), 'error'),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${config.provider} (${env})`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <Select
          label="Mode"
          value={form.mode}
          onChange={(e) => setForm({ ...form, mode: e.target.value as PaymentProviderModeValue })}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <Input
          label="Public key"
          value={form.publicKey}
          onChange={(e) => setForm({ ...form, publicKey: e.target.value })}
        />
        <Input
          label="Secret key reference"
          value={form.secretKeyRef}
          placeholder="payments/stripe/live/secret-key"
          onChange={(e) => setForm({ ...form, secretKeyRef: e.target.value })}
        />
        <Input
          label="Webhook secret reference"
          value={form.webhookSecretRef}
          onChange={(e) => setForm({ ...form, webhookSecretRef: e.target.value })}
        />
        <Input
          label="API base URL (optional)"
          value={form.apiBaseUrl}
          onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })}
        />
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Priority"
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
          <Input
            label="Timeout (ms)"
            type="number"
            value={form.timeoutMs}
            onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })}
          />
          <Input
            label="Max retries"
            type="number"
            value={form.maxRetries}
            onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })}
          />
        </div>
        <p className="text-xs text-text-muted">
          Store secret <em>references</em> (a path in the secret manager), never raw secret values.
        </p>
      </div>
    </Dialog>
  );
}

function RouteDialog({
  env,
  route,
  onClose,
  onSaved,
}: {
  env: PaymentEnvValue;
  route: PaymentRouteRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [form, setForm] = useState({
    country: route?.country ?? '*',
    currency: route?.currency ?? '*',
    method: route?.method ?? '*',
    provider: route?.provider ?? '',
    failoverProvider: route?.failoverProvider ?? '',
    priority: route?.priority ?? 100,
    active: route?.active ?? true,
  });

  const save = useMutation({
    mutationFn: () => {
      const input = {
        country: form.country,
        currency: form.currency,
        method: form.method,
        provider: form.provider,
        failoverProvider: form.failoverProvider || null,
        priority: Number(form.priority),
        active: form.active,
      };
      return route
        ? api.admin.paymentConfig.updateRoute(route.id, input, env)
        : api.admin.paymentConfig.createRoute(input, env);
    },
    onSuccess: () => {
      push(route ? 'Route updated' : 'Route created', 'success');
      onSaved();
    },
    onError: (e) => push(errorMessage(e), 'error'),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={route ? `Edit route (${env})` : `Add route (${env})`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Country"
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
          />
          <Input
            label="Currency"
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          />
          <Input
            label="Method"
            value={form.method}
            onChange={(e) => setForm({ ...form, method: e.target.value })}
          />
        </div>
        <Input
          label="Provider"
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        />
        <Input
          label="Failover provider (optional)"
          value={form.failoverProvider}
          onChange={(e) => setForm({ ...form, failoverProvider: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Priority"
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Active
          </label>
        </div>
        <p className="text-xs text-text-muted">
          Use <code>*</code> as a wildcard. The most specific active route wins.
        </p>
      </div>
    </Dialog>
  );
}

function OperationsSection() {
  const { push } = useToast();
  const health = useQuery({
    queryKey: ['admin', 'payment-health'],
    queryFn: () => api.admin.paymentConfig.health(),
  });
  const settlement = useQuery({
    queryKey: ['admin', 'payment-settlement'],
    queryFn: () => api.admin.paymentConfig.settlement(),
  });
  const reconcile = useMutation({
    mutationFn: () => api.admin.paymentConfig.reconciliation(),
    onSuccess: (r) =>
      push(
        `Reconciled ${r.checked}: ${r.matched} matched, ${r.mismatched} mismatched, ${r.unverifiable} unverifiable`,
        r.mismatched > 0 ? 'warning' : 'success',
      ),
    onError: (e) => push(errorMessage(e), 'error'),
  });

  const healthColumns: Column<ProviderHealthRow>[] = [
    { key: 'provider', header: 'Provider', render: (r) => <strong>{r.provider}</strong> },
    {
      key: 'healthy',
      header: 'Status',
      render: (r) => (
        <Badge tone={r.healthy ? 'success' : 'error'}>{r.healthy ? 'Healthy' : 'Unhealthy'}</Badge>
      ),
    },
    { key: 'mode', header: 'Mode', render: (r) => r.mode ?? '—' },
    { key: 'message', header: 'Detail', render: (r) => r.message ?? '—' },
  ];

  const settlementColumns: Column<SettlementLine>[] = [
    { key: 'provider', header: 'Provider', render: (r) => <strong>{r.provider}</strong> },
    { key: 'currency', header: 'Currency', render: (r) => r.currency },
    { key: 'gross', header: 'Gross', render: (r) => money(r.grossMinor) },
    { key: 'refunded', header: 'Refunded', render: (r) => money(r.refundedMinor) },
    { key: 'net', header: 'Net', render: (r) => <strong>{money(r.netMinor)}</strong> },
    { key: 'count', header: 'Payments', render: (r) => r.count },
  ];

  return (
    <>
      <Card
        title="Provider health"
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => reconcile.mutate()}
            loading={reconcile.isPending}
          >
            Run reconciliation
          </Button>
        }
      >
        <DataTable
          columns={healthColumns}
          rows={health.data?.providers}
          loading={health.isLoading}
          rowKey={(r) => r.provider}
        />
      </Card>

      <Card title="Settlement (last 30 days)">
        <DataTable
          columns={settlementColumns}
          rows={settlement.data}
          loading={settlement.isLoading}
          rowKey={(r) => `${r.provider}-${r.currency}`}
        />
      </Card>

      <LiveReadinessCard />
    </>
  );
}

function LiveReadinessCard() {
  const readiness = useQuery({
    queryKey: ['admin', 'payment-live-readiness'],
    queryFn: () => api.admin.paymentConfig.liveReadiness(),
  });
  const r = readiness.data;
  const Row = ({ passed, label, detail }: { passed: boolean; label: string; detail?: string }) => (
    <li className="flex items-center gap-2 text-sm">
      {passed ? (
        <CheckCircle2 className="h-4 w-4 text-status-success" />
      ) : (
        <XCircle className="h-4 w-4 text-status-error" />
      )}
      <span className={passed ? '' : 'text-status-error'}>{label}</span>
      {detail && <span className="text-xs text-text-muted">— {detail}</span>}
    </li>
  );
  return (
    <Card
      title="Payment-live readiness"
      action={
        r ? <Badge tone={r.ok ? 'success' : 'error'}>{r.ok ? 'GO' : 'NO-GO'}</Badge> : undefined
      }
    >
      {readiness.isLoading || !r ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-1">
            {r.global.map((c) => (
              <Row key={c.key} passed={c.passed} label={c.label} detail={c.detail} />
            ))}
          </ul>
          {r.providers.map((p) => (
            <div key={p.provider}>
              <p className="mb-1 text-xs font-medium text-text-muted">
                {p.provider} {p.ok ? '✓' : '✗'}
              </p>
              <ul className="space-y-1 pl-2">
                {p.checks.map((c) => (
                  <Row key={c.key} passed={c.passed} label={c.label} detail={c.detail} />
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-text-muted">
            Never exposes secrets — booleans only. Production only becomes live when every check is
            green.
          </p>
        </div>
      )}
    </Card>
  );
}
