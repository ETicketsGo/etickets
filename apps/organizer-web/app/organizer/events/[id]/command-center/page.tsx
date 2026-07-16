'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Info,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  MetricCard,
  Select,
  Spinner,
  Textarea,
  dateTime,
  errorMessage,
  useAuthUser,
  useToast,
  hasAnyRole,
  type AlertSeverity,
  type BadgeTone,
  type Column,
  type ActivityRow,
  type CommandCenterAlertRow,
} from '@eticketsgo/web-kit';

const POLL_MS = 15_000;
const MANAGER_ROLES = ['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'ADMIN', 'SUPER_ADMIN'];

const SEV_TONE: Record<AlertSeverity, BadgeTone> = {
  critical: 'error',
  warning: 'warning',
  info: 'neutral',
};
function SeverityIcon({ severity }: { severity: AlertSeverity }) {
  const cls = 'h-4 w-4 shrink-0';
  if (severity === 'critical') return <AlertOctagon className={cls} aria-hidden />;
  if (severity === 'warning') return <AlertTriangle className={cls} aria-hidden />;
  return <Info className={cls} aria-hidden />;
}
function fmtAge(ms: number | null): string {
  if (ms === null) return '—';
  const m = Math.round(ms / 60_000);
  return m < 1 ? '<1 min' : `${m} min`;
}

export default function CommandCenter() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuthUser();
  const canManage = hasAnyRole(user, MANAGER_ROLES);

  const { data: event } = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const orgId = event?.organizationId;
  const [sessionId, setSessionId] = useState('');
  const activeSession = sessionId || event?.sessions[0]?.id || '';

  const snap = useQuery({
    queryKey: ['command-center', orgId, activeSession],
    queryFn: () => api.offlineCheckin.commandCenter(orgId!, activeSession),
    enabled: !!orgId && !!activeSession,
    refetchInterval: POLL_MS, // production-safe polling
    retry: false,
  });

  const [activityPage, setActivityPage] = useState(1);
  const activity = useQuery({
    queryKey: ['command-center-activity', orgId, activityPage],
    queryFn: () => api.offlineCheckin.commandCenterActivity(orgId!, activityPage),
    enabled: !!orgId,
    retry: false,
  });

  const [acking, setAcking] = useState<CommandCenterAlertRow | null>(null);
  const [reason, setReason] = useState('');
  const ack = useMutation({
    mutationFn: () =>
      api.offlineCheckin.acknowledgeAlert({
        organizationId: orgId!,
        eventSessionId: activeSession,
        alertKey: acking!.key,
        severity: acking!.severity,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.push('Alert acknowledged.', 'success');
      setAcking(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['command-center'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const permissionDenied =
    snap.isError && /403|forbidden|not a member/i.test(errorMessage(snap.error));

  const s = snap.data;
  const activityColumns: Column<ActivityRow>[] = [
    { key: 'action', header: 'Action', render: (a) => a.action.replaceAll('_', ' ') },
    {
      key: 'entity',
      header: 'Entity',
      render: (a) => `${a.entityType}${a.entityId ? ` · ${a.entityId.slice(0, 8)}` : ''}`,
    },
    { key: 'actor', header: 'Actor', render: (a) => a.actor?.email ?? 'system' },
    { key: 'when', header: 'When', render: (a) => dateTime(a.createdAt) },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Live Event Command Center</h2>
          <p className="text-caption text-text-muted">
            Read-only operational view. The server remains authoritative — nothing here admits a
            ticket or changes the gate.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Select
            id="cc-session"
            label="Session"
            value={activeSession}
            onChange={(e) => setSessionId(e.target.value)}
          >
            {event?.sessions.map((se) => (
              <option key={se.id} value={se.id}>
                {dateTime(se.startsAt)}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-2 pb-1">
            <span className="text-caption text-text-muted" aria-live="polite">
              {snap.isFetching ? 'Refreshing…' : s ? `Updated ${dateTime(s.generatedAt)}` : ''}
            </span>
            <Button variant="outline" size="sm" onClick={() => snap.refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </div>

      {permissionDenied ? (
        <ErrorState message="You don't have permission to view this event's command center." />
      ) : snap.isError ? (
        <ErrorState
          message="We couldn't load the command center. Please try again."
          onRetry={() => snap.refetch()}
        />
      ) : snap.isLoading || !s ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Alerts first — severity-ranked, icon + text, never colour alone. */}
          <Card title={`Alerts (${s.alerts.length})`}>
            {s.alerts.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <ShieldCheck className="h-4 w-4 text-status-success" aria-hidden /> No active alerts
                for this session.
              </p>
            ) : (
              <ul className="space-y-2" aria-label="Operational alerts">
                {s.alerts.map((a) => (
                  <li
                    key={a.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <SeverityIcon severity={a.severity} />
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          <Badge tone={SEV_TONE[a.severity]}>{a.severity.toUpperCase()}</Badge>{' '}
                          {a.title}
                          {a.acknowledged && (
                            <span className="ml-2 text-xs font-normal text-text-muted">
                              · acknowledged
                            </span>
                          )}
                        </p>
                        <p className="text-caption text-text-secondary">{a.detail}</p>
                        {a.acknowledged && a.acknowledgeReason && (
                          <p className="text-caption text-text-muted">
                            Ack: “{a.acknowledgeReason}”
                          </p>
                        )}
                      </div>
                    </div>
                    {canManage && !a.acknowledged && (
                      <Button variant="outline" size="sm" onClick={() => setAcking(a)}>
                        Acknowledge
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Activation verdict + blocking / downgrade reasons */}
          <Card
            title="Activation"
            action={
              <Badge
                tone={
                  s.activation.verdict === 'GO'
                    ? 'success'
                    : s.activation.verdict === 'CONDITIONAL_GO'
                      ? 'warning'
                      : 'error'
                }
              >
                {s.activation.verdict.replaceAll('_', ' ')}
              </Badge>
            }
          >
            <div className="space-y-2">
              {s.downgrade.downgradeActive && (
                <p className="flex items-center gap-2 text-sm text-status-error">
                  <ShieldAlert className="h-4 w-4" aria-hidden /> Downgraded:{' '}
                  {s.downgrade.downgradeReasons.join('; ') || 'a safety condition is active'}.
                </p>
              )}
              <ul className="grid gap-1 sm:grid-cols-2">
                {s.activation.checks
                  .filter((c) => !c.passed)
                  .map((c) => (
                    <li
                      key={c.key}
                      className="flex items-center gap-1.5 text-sm text-text-secondary"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 text-status-warning" aria-hidden />
                      {c.label}
                      {c.blocking ? ' (blocking)' : ''}
                    </li>
                  ))}
                {s.activation.checks.every((c) => c.passed) && (
                  <li className="flex items-center gap-1.5 text-sm text-status-success">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> All checks pass.
                  </li>
                )}
              </ul>
            </div>
          </Card>

          {/* Attendance + reconciliation metrics */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Tickets" value={s.attendance.total} />
            <MetricCard label="Admitted" value={s.attendance.admitted} />
            <MetricCard label="Remaining" value={s.attendance.remaining} />
            <MetricCard label="Admission rate" value={`${s.attendance.admissionRate}%`} />
            <MetricCard label="Reconciled scans" value={s.reconciliation.totalScans} />
            <MetricCard label="Accepted" value={s.reconciliation.accepted} />
            <MetricCard label="Duplicates" value={s.reconciliation.duplicates} />
            <MetricCard label="Rejected" value={s.reconciliation.rejected} />
            <MetricCard label="Pending reviews" value={s.reconciliation.pendingReviews} />
            <MetricCard
              label="Active devices"
              value={`${s.devices.counts.online + s.devices.counts.offline}`}
            />
            <MetricCard label="Online devices" value={s.devices.counts.online} />
            <MetricCard label="Sync latency (avg)" value={fmtAge(s.sync.latency.avgMs)} />
          </div>

          {/* Devices */}
          <Card title="Devices">
            <p className="mb-2 text-caption text-text-muted">
              {s.devices.counts.active} active · {s.devices.counts.online} online ·{' '}
              {s.devices.counts.revoked} revoked · {s.devices.counts.expired} expired ·{' '}
              {s.devices.counts.pending} pending. Manifest v{s.manifest.version ?? '—'}
              {s.manifest.stale ? ' (stale)' : ''}.
            </p>
            <ul className="divide-y divide-border text-sm">
              {s.devices.list.slice(0, 10).map((d) => (
                <li key={d.id} className="flex items-center justify-between py-1.5">
                  <span className="text-text-secondary">{d.name}</span>
                  <span className="flex items-center gap-2 text-text-muted">
                    <Badge tone={d.status === 'ACTIVE' ? 'success' : 'neutral'}>{d.status}</Badge>
                    <span className="text-xs">
                      seen {d.lastSeenAt ? dateTime(d.lastSeenAt) : 'never'} · v{d.manifestVersion}
                    </span>
                  </span>
                </li>
              ))}
              {s.devices.list.length === 0 && (
                <li className="py-2 text-text-muted">No devices registered.</li>
              )}
            </ul>
          </Card>
        </>
      )}

      {/* Recent operational activity (paginated) */}
      <Card title="Recent activity">
        <DataTable
          columns={activityColumns}
          rows={activity.data?.data}
          loading={activity.isLoading}
          error={activity.isError ? "We couldn't load activity." : undefined}
          onRetry={() => activity.refetch()}
          empty={<EmptyState title="No offline activity yet" />}
          rowKey={(a) => a.id}
        />
        {activity.data && activity.data.meta.totalPages > 1 && (
          <div className="mt-2 flex items-center justify-between text-sm text-text-muted">
            <Button
              variant="ghost"
              size="sm"
              disabled={activityPage <= 1}
              onClick={() => setActivityPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span>
              Page {activity.data.meta.page} of {activity.data.meta.totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={activityPage >= activity.data.meta.totalPages}
              onClick={() => setActivityPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </Card>

      <Dialog
        open={!!acking}
        onClose={() => setAcking(null)}
        title="Acknowledge alert"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAcking(null)}>
              Cancel
            </Button>
            <Button loading={ack.isPending} disabled={!reason.trim()} onClick={() => ack.mutate()}>
              Acknowledge
            </Button>
          </div>
        }
      >
        {acking && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Acknowledging <span className="font-medium text-text-primary">{acking.title}</span>{' '}
              records who/when/why for audit. It does <strong>not</strong> resolve the underlying
              condition or change the gate — the alert stays visible until the condition clears.
            </p>
            <Textarea
              id="ack-reason"
              label="Reason (required)"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What is being done about this?"
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}
