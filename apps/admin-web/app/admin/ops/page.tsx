'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  MetricCard,
  Dialog,
  Textarea,
  PageHeader,
  ErrorState,
  EmptyState,
  Skeleton,
  useToast,
  errorMessage,
  dateTime,
  titleCase,
  type BadgeTone,
  type Column,
  type OpsDependencyCheck,
  type OpsQueueCheck,
  type OpsFailedJob,
} from '@eticketsgo/web-kit';

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'up':
    case 'ok':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'down':
      return 'error';
    default:
      return 'neutral';
  }
}

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function DependencyTile({
  label,
  check,
}: {
  label: string;
  check: OpsDependencyCheck | OpsQueueCheck | { status: string };
}) {
  const latency = 'latencyMs' in check ? check.latencyMs : undefined;
  const error = 'error' in check ? check.error : undefined;
  return (
    <div className="rounded-lg border border-border bg-background-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.9375rem] text-text-muted">{label}</p>
        <Badge tone={statusTone(check.status)}>{titleCase(check.status)}</Badge>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{latency != null ? `${latency} ms` : '—'}</p>
      {error && <p className="mt-1 line-clamp-2 text-caption text-status-error">{error}</p>}
    </div>
  );
}

export default function AdminOps() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const health = useQuery({
    queryKey: ['admin', 'ops', 'health'],
    queryFn: () => api.admin.opsHealth(),
    refetchInterval: 15000,
  });
  const queues = useQuery({
    queryKey: ['admin', 'ops', 'queues'],
    queryFn: () => api.admin.opsQueues(),
    refetchInterval: 15000,
  });
  const failed = useQuery({
    queryKey: ['admin', 'ops', 'failed'],
    queryFn: () => api.admin.opsFailedJobs(25),
    refetchInterval: 15000,
  });
  const flags = useQuery({
    queryKey: ['admin', 'ops', 'flags'],
    queryFn: () => api.admin.opsFlags(),
  });
  const maintenance = useQuery({
    queryKey: ['admin', 'ops', 'maintenance'],
    queryFn: () => api.admin.maintenance(),
  });

  const [retryAllOpen, setRetryAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Maintenance dialog state.
  const [maintOpen, setMaintOpen] = useState(false);
  const [maintMessage, setMaintMessage] = useState('');

  async function refreshAll() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'ops'] });
  }

  async function doRetryAll() {
    setBusy(true);
    try {
      const res = await api.admin.opsRetryFailed();
      toast.push(`Retried ${res.retried} of ${res.total} failed jobs.`, 'success');
      setRetryAllOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ops', 'failed'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ops', 'queues'] });
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doRetryJob(id: string | null) {
    if (!id) return;
    setBusy(true);
    try {
      await api.admin.opsRetryJob(id);
      toast.push(`Retried job ${id}.`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ops', 'failed'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ops', 'queues'] });
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  function openMaintenanceDialog() {
    setMaintMessage(maintenance.data?.message ?? '');
    setMaintOpen(true);
  }

  async function toggleMaintenance() {
    const next = !(maintenance.data?.enabled ?? false);
    setBusy(true);
    try {
      await api.admin.setMaintenance({
        enabled: next,
        message: maintMessage.trim() || undefined,
      });
      toast.push(next ? 'Maintenance mode ENABLED.' : 'Maintenance mode disabled.', 'warning');
      setMaintOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ops', 'maintenance'] });
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const failedColumns: Column<OpsFailedJob>[] = [
    {
      key: 'id',
      header: 'Job ID',
      render: (r) => <span className="font-mono text-xs">{r.id ?? '—'}</span>,
    },
    { key: 'name', header: 'Name', render: (r) => r.name },
    {
      key: 'reason',
      header: 'Failed reason',
      render: (r) => (
        <span className="line-clamp-2 text-status-error">{r.failedReason ?? '—'}</span>
      ),
    },
    { key: 'attempts', header: 'Attempts', render: (r) => r.attemptsMade },
    { key: 'when', header: 'When', render: (r) => (r.timestamp ? dateTime(r.timestamp) : '—') },
    {
      key: 'action',
      header: '',
      render: (r) => (
        <Button variant="outline" size="sm" loading={busy} onClick={() => void doRetryJob(r.id)}>
          Retry
        </Button>
      ),
    },
  ];

  const h = health.data;
  const q = queues.data;
  const m = maintenance.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations"
        description="Internal system health, queues, feature flags, and maintenance mode."
        action={
          <Button variant="outline" onClick={() => void refreshAll()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {/* Maintenance banner */}
      {m?.enabled && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-status-warning/40 bg-status-warning/10 p-4"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" />
          <div>
            <p className="font-semibold text-text-primary">Maintenance mode is ON</p>
            <p className="text-sm text-text-secondary">
              Non-admin traffic is being served a 503. Health, auth and admin routes remain
              available. {m.message ? `Message: “${m.message}”` : ''}
            </p>
          </div>
        </div>
      )}

      {/* System health */}
      <Card title="System health">
        {health.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : health.isError || !h ? (
          <ErrorState message="Couldn't load system health." onRetry={() => health.refetch()} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-text-muted">Overall</span>
              <Badge tone={statusTone(h.status)}>{titleCase(h.status)}</Badge>
              <span className="text-sm text-text-muted">
                · {h.nodeEnv} · uptime {formatUptime(h.uptime)}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <DependencyTile label="Database" check={h.database} />
              <DependencyTile label="Redis / cache" check={h.redis} />
              <DependencyTile label="Queue (holds)" check={h.queue} />
              <DependencyTile label="Storage (S3/blob)" check={h.storage} />
            </div>
          </div>
        )}
      </Card>

      {/* Queue health */}
      <Card
        title="Queue health — holds"
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={(q?.counts.failed ?? 0) === 0}
            onClick={() => setRetryAllOpen(true)}
          >
            Retry all failed
          </Button>
        }
      >
        {queues.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : queues.isError || !q ? (
          <ErrorState message="Couldn't load queue health." onRetry={() => queues.refetch()} />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <MetricCard label="Waiting" value={q.counts.waiting} />
              <MetricCard label="Active" value={q.counts.active} tone="info" />
              <MetricCard label="Completed" value={q.counts.completed} tone="success" />
              <MetricCard
                label="Failed"
                value={q.counts.failed}
                tone={q.counts.failed > 0 ? 'error' : 'neutral'}
              />
              <MetricCard label="Delayed" value={q.counts.delayed} />
              <MetricCard label="Paused" value={q.counts.paused} />
            </div>
            {q.repeatable.length > 0 && (
              <p className="text-caption text-text-muted">
                Schedules:{' '}
                {q.repeatable
                  .map(
                    (r) =>
                      `${r.name} (every ${r.every ? `${Number(r.every) / 1000}s` : (r.pattern ?? '—')})`,
                  )
                  .join(' · ')}
              </p>
            )}
            <div>
              <p className="mb-2 text-[0.9375rem] font-medium text-text-secondary">Failed jobs</p>
              <DataTable
                columns={failedColumns}
                rows={failed.data?.jobs}
                loading={failed.isLoading}
                error={failed.isError ? "Couldn't load failed jobs." : undefined}
                onRetry={() => failed.refetch()}
                empty={<EmptyState title="No failed jobs" hint="The queue is healthy." />}
                rowKey={(r) => r.id ?? `${r.name}-${r.timestamp}`}
              />
            </div>
          </div>
        )}
      </Card>

      {/* Feature flags */}
      <Card title="Feature flags">
        {flags.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : flags.isError || !flags.data ? (
          <ErrorState message="Couldn't load feature flags." onRetry={() => flags.refetch()} />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {flags.data.flags.map((f) => (
                <div
                  key={f.key}
                  className="flex items-center justify-between rounded-md border border-border bg-background-surface px-3 py-2"
                >
                  <span className="text-sm text-text-primary">{f.key}</span>
                  <Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'On' : 'Off'}</Badge>
                </div>
              ))}
            </div>
            <p className="text-caption text-text-muted">{flags.data.note}</p>
          </div>
        )}
      </Card>

      {/* Maintenance mode */}
      <Card title="Maintenance mode">
        {maintenance.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : maintenance.isError ? (
          <ErrorState
            message="Couldn't load maintenance state."
            onRetry={() => maintenance.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-secondary">Current state:</span>
                <Badge tone={m?.enabled ? 'warning' : 'success'}>
                  {m?.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              <p className="mt-1 max-w-xl text-caption text-text-muted">
                When enabled, all non-admin traffic receives a 503. Health checks, authentication,
                and every admin route stay available so you can always turn it back off. Off by
                default; if Redis is unreachable the guard fails open (never blocks).
              </p>
            </div>
            <Button variant={m?.enabled ? 'outline' : 'primary'} onClick={openMaintenanceDialog}>
              {m?.enabled ? 'Disable maintenance' : 'Enable maintenance'}
            </Button>
          </div>
        )}
      </Card>

      {/* Retry-all confirm */}
      <Dialog
        open={retryAllOpen}
        onClose={() => setRetryAllOpen(false)}
        title="Retry all failed jobs?"
        footer={
          <>
            <Button variant="outline" onClick={() => setRetryAllOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void doRetryAll()}>
              Retry all
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          This re-queues every failed job on the holds queue (bounded to 100). Jobs already retried
          elsewhere are skipped.
        </p>
      </Dialog>

      {/* Maintenance confirm */}
      <Dialog
        open={maintOpen}
        onClose={() => setMaintOpen(false)}
        title={m?.enabled ? 'Disable maintenance mode?' : 'Enable maintenance mode?'}
        footer={
          <>
            <Button variant="outline" onClick={() => setMaintOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={m?.enabled ? 'primary' : 'danger'}
              loading={busy}
              onClick={() => void toggleMaintenance()}
            >
              {m?.enabled ? 'Disable' : 'Enable maintenance'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {!m?.enabled && (
            <p className="text-sm text-status-warning">
              Enabling maintenance mode will serve a 503 to all customer and organizer traffic.
              Admin, auth, and health routes remain available.
            </p>
          )}
          <Textarea
            label="Message (optional)"
            rows={3}
            value={maintMessage}
            onChange={(e) => setMaintMessage(e.target.value)}
            placeholder="e.g. Back at 02:00 UTC after a database upgrade."
          />
        </div>
      </Dialog>
    </div>
  );
}
