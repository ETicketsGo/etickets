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
  recordedAt,
  titleCase,
  type BadgeTone,
  type Column,
  type OpsDependencyCheck,
  type OpsQueueCheck,
  type OpsFailedJob,
  type OpsAlertsStatus,
  type OpsPilotStatus,
  money,
} from '@eticketsgo/web-kit';
import { missingDutyNote, useHolds } from '@/lib/capabilities';
import { backupHealthView } from '@/lib/backup-health';

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
      {'failed' in check && (check.failed ?? 0) > 0 ? (
        <p className="mt-1 text-caption text-text-secondary">
          {check.failed} failed
          {check.recentFailed === 0
            ? ` - none in the last 24 hours${check.lastFailedAt ? `, last on ${new Date(check.lastFailedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`
            : ` - ${check.recentFailed} in the last 24 hours`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The database backup, as the health endpoint already reports it. In PRODUCTION a stale or
 * missing backup is what turns Overall to Degraded, so the page has to say which it is.
 */
function BackupTile({ backup }: { backup: Parameters<typeof backupHealthView>[0] }) {
  const v = backupHealthView(backup, recordedAt);
  if (!v) return null;
  return (
    <div className="rounded-lg border border-border bg-background-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[0.9375rem] text-text-muted">Database backup</p>
        <Badge tone={v.tone}>{v.label}</Badge>
      </div>
      <p className="mt-2 break-words text-sm text-text-secondary">{v.detail}</p>
      {v.note && <p className="mt-1 text-caption text-text-secondary">{v.note}</p>}
    </div>
  );
}

/**
 * Whether a money-critical failure (a refused payment webhook, money captured for a booking
 * that cannot take it, a new finance discrepancy) reaches a person by email. Read-only: the
 * recipients are set with OPS_ALERT_EMAILS on the API and the worker, never from here.
 */
function OpsAlertsLine({ alerts }: { alerts?: OpsAlertsStatus }) {
  if (!alerts) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-background-surface p-4">
      <p className="text-[0.9375rem] text-text-muted">Ops alerts</p>
      <Badge tone={alerts.configured ? 'success' : 'warning'}>
        {alerts.configured ? 'Configured' : 'Not configured'}
      </Badge>
      <p className="min-w-0 flex-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
        {alerts.configured
          ? `Emailed to ${alerts.recipients} ${alerts.recipients === 1 ? 'address' : 'addresses'} (${alerts.emailProvider}).`
          : (alerts.reason ?? 'Alerts are written to the log only.')}{' '}
        {alerts.lastAlertAt
          ? `Last alert: ${recordedAt(alerts.lastAlertAt)}${alerts.lastAlertKind ? ` (${alerts.lastAlertKind})` : ''}.`
          : 'No alert has been sent yet.'}
      </p>
    </div>
  );
}

/**
 * The controlled India pilot, read-only: whether it is on, the limits in force, today's counted
 * sales against the cap, and the last automatic pause. Every limit is set with PILOT_*
 * variables on the API and the worker (docs/go-live/PILOT-GUARD.md), never from here.
 */
function PilotCard({ pilot }: { pilot?: OpsPilotStatus | null }) {
  if (pilot === undefined) return null;
  const tone: BadgeTone = !pilot
    ? 'neutral'
    : pilot.mode === 'off'
      ? 'neutral'
      : pilot.valid
        ? 'success'
        : 'error';
  const label = !pilot
    ? 'Unknown'
    : pilot.mode === 'off'
      ? 'Off'
      : pilot.valid
        ? 'On'
        : 'On - misconfigured';
  const l = pilot?.limits ?? null;
  const last = pilot?.lastAutoPause ?? null;
  return (
    <Card title="Controlled pilot">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-text-muted">Pilot mode</span>
          <Badge tone={tone}>{label}</Badge>
          <span className="min-w-0 flex-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
            {!pilot
              ? 'The pilot status could not be read.'
              : pilot.mode === 'off'
                ? 'Sales follow the normal rules. Set PILOT_MODE=on to apply the pilot limits.'
                : pilot.valid
                  ? 'Only sales inside the limits below are accepted.'
                  : 'Nothing can be sold until the variables below are fixed.'}
          </span>
        </div>
        {pilot && pilot.problems.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-status-error">
            {pilot.problems.map((p) => (
              <li key={p} className="[overflow-wrap:anywhere]">
                {p}
              </li>
            ))}
          </ul>
        )}
        {l && (
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-text-muted">Organizers allowed</dt>
              <dd className="font-mono text-caption text-text-primary [overflow-wrap:anywhere]">
                {l.organizationIds.join(', ')}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Payments</dt>
              <dd className="text-text-primary">
                {l.currencies.join(', ')} via {l.providers.join(', ')}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Seating</dt>
              <dd className="text-text-primary">
                {l.gaOnly ? 'General admission only. No cinema shows.' : 'Any seating'}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Largest order</dt>
              <dd className="tabular-nums text-text-primary">
                {l.currencies.map((c) => money(l.maxOrderMinor, c)).join(' / ')}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Buyers</dt>
              <dd className="text-text-primary">
                {l.buyerAllowlistCount > 0
                  ? `Only ${l.buyerAllowlistCount} listed ${l.buyerAllowlistCount === 1 ? 'address' : 'addresses'}`
                  : 'Anyone'}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Automatic pause</dt>
              <dd className="text-text-primary">
                {l.autoPause
                  ? `On (webhook rejections: ${l.webhookRejectThreshold} in ${l.webhookWindowMinutes} minutes)`
                  : 'Off'}
              </dd>
            </div>
          </dl>
        )}
        {l && pilot && (
          <div className="space-y-2">
            <p className="text-sm text-text-muted">
              Sales counted today ({pilot.today.day}, India time)
            </p>
            {pilot.today.sales.map((s) => {
              const pct = s.capMinor > 0 ? Math.min(100, (s.countedMinor / s.capMinor) * 100) : 0;
              return (
                <div key={s.currency} className="space-y-1">
                  <p className="text-sm tabular-nums text-text-primary">
                    {money(s.countedMinor, s.currency)} of {money(s.capMinor, s.currency)}
                  </p>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-background-subtle"
                    role="img"
                    aria-label={`${Math.round(pct)} percent of the daily cap`}
                  >
                    <div
                      className={`h-full ${pct >= 100 ? 'bg-status-error' : pct >= 80 ? 'bg-status-warning' : 'bg-status-success'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <p className="text-caption text-text-muted">
              Paid bookings plus unpaid ones still holding tickets.
            </p>
          </div>
        )}
        <p className="text-sm text-text-secondary [overflow-wrap:anywhere]">
          {last
            ? `Last automatic pause: ${recordedAt(last.at)}${last.trigger ? ` (${last.trigger})` : ''}, event ${last.eventId ?? 'unknown'}.`
            : 'No event has been paused automatically.'}
        </p>
      </div>
    </Card>
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

  /*
    Reading the flag needs OPS_READ, like the rest of this page; switching it needs
    PLATFORM_CONFIG, because it takes the storefront offline for everybody.
  */
  const mayToggleMaintenance = useHolds('PLATFORM_CONFIG');
  /*
    Retrying re-runs a job that already ran once, so it needs OPS_EXECUTE; seeing the queue is
    OPS_READ. Without it the Retry buttons are not drawn at all - the API would refuse them.
  */
  const mayRetry = useHolds('OPS_EXECUTE');

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

  /*
    The job, then what went wrong, then the one thing to do about it.

    Six columns - id, name, reason, attempts, when, button - with a stack trace in the middle
    made this the widest table in the console. The failure IS the row, so it reads as one.
  */
  const failedColumns: Column<OpsFailedJob>[] = [
    {
      key: 'job',
      header: 'Failed job',
      render: (r) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{r.name}</p>
          <p className="line-clamp-2 text-caption text-status-error">
            {r.failedReason ?? 'No reason recorded'}
          </p>
          <p className="font-mono text-caption text-text-muted">{r.id ?? 'no id'}</p>
        </div>
      ),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      className: 'whitespace-nowrap',
      render: (r) => (
        <div className="space-y-1">
          <p className="tabular-nums text-text-primary">{r.attemptsMade}</p>
          <p className="text-caption text-text-muted">
            {r.timestamp ? recordedAt(r.timestamp) : 'no timestamp'}
          </p>
        </div>
      ),
    },
    // The Retry column exists only for somebody who may retry (see `mayRetry`).
    ...(mayRetry
      ? [
          {
            key: 'action',
            header: '',
            className: 'whitespace-nowrap',
            render: (r: OpsFailedJob) => (
              <Button
                variant="outline"
                size="sm"
                loading={busy}
                onClick={() => void doRetryJob(r.id)}
              >
                Retry
              </Button>
            ),
          },
        ]
      : []),
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
                · {h.appEnv ?? h.nodeEnv} · uptime {formatUptime(h.uptime)}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <DependencyTile label="Database" check={h.database} />
              <DependencyTile label="Redis / cache" check={h.redis} />
              <DependencyTile label="Queue (holds)" check={h.queue} />
              <DependencyTile label="Storage (S3/blob)" check={h.storage} />
            </div>
            <BackupTile backup={h.backup} />
            <OpsAlertsLine alerts={h.opsAlerts} />
          </div>
        )}
      </Card>

      {h && <PilotCard pilot={h.pilot} />}

      {/* Queue health */}
      <Card
        title="Queue health — holds"
        action={
          mayRetry ? (
            <Button
              variant="outline"
              size="sm"
              disabled={(q?.counts.failed ?? 0) === 0}
              onClick={() => setRetryAllOpen(true)}
            >
              Retry all failed
            </Button>
          ) : (
            <p className="max-w-xs text-caption text-text-muted">
              {missingDutyNote('retry failed jobs', 'OPS_EXECUTE')}
            </p>
          )
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
            {mayToggleMaintenance ? (
              <Button variant={m?.enabled ? 'outline' : 'primary'} onClick={openMaintenanceDialog}>
                {m?.enabled ? 'Disable maintenance' : 'Enable maintenance'}
              </Button>
            ) : (
              <p className="max-w-xs text-caption text-text-muted">
                Switching maintenance mode needs the Platform configuration duty.
              </p>
            )}
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
