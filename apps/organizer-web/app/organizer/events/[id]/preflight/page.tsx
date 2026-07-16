'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Printer,
} from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  ErrorState,
  Select,
  Spinner,
  dateTime,
  errorMessage,
  type BadgeTone,
  type PreflightCheckRow,
  type PreflightStatus,
  type PreflightVerdict,
} from '@eticketsgo/web-kit';
import { listQueue, loadManifest } from '@/lib/offline/checkin-queue';

const VERDICT: Record<
  PreflightVerdict,
  { tone: BadgeTone; label: string; Icon: typeof ShieldCheck }
> = {
  READY: { tone: 'success', label: 'READY', Icon: ShieldCheck },
  WARNING: { tone: 'warning', label: 'WARNING', Icon: ShieldAlert },
  NOT_READY: { tone: 'error', label: 'NOT READY', Icon: ShieldAlert },
};
function StatusIcon({ status }: { status: PreflightStatus }) {
  const cls = 'h-5 w-5 shrink-0';
  if (status === 'pass')
    return <CheckCircle2 className={`${cls} text-status-success`} aria-hidden />;
  if (status === 'fail') return <XCircle className={`${cls} text-status-error`} aria-hidden />;
  return <AlertTriangle className={`${cls} text-status-warning`} aria-hidden />;
}
const STATUS_TONE: Record<PreflightStatus, BadgeTone> = {
  pass: 'success',
  warn: 'warning',
  fail: 'error',
};
const STATUS_TEXT: Record<PreflightStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
};

export default function PreflightPage() {
  const { id } = useParams<{ id: string }>();
  const { data: event } = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const orgId = event?.organizationId;

  const [sessionId, setSessionId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const activeSession = sessionId || event?.sessions[0]?.id || '';

  const devices = useQuery({
    queryKey: ['checkin-devices', orgId, id],
    queryFn: () => api.offlineCheckin.listDevices(orgId!, id),
    enabled: !!orgId,
    retry: false,
  });

  const run = useMutation({
    mutationFn: async () => {
      // The device runs its own preflight: report local clock, held manifest + queue.
      const cached = await loadManifest(activeSession).catch(() => null);
      const queue = await listQueue().catch(() => []);
      const queueDepth = queue.filter(
        (q) => q.status === 'PENDING' || q.status === 'SYNCING',
      ).length;
      const clientManifestVersion = cached
        ? (cached.meta as { version?: number }).version
        : undefined;
      return api.offlineCheckin.preflight({
        organizationId: orgId!,
        eventSessionId: activeSession,
        deviceId,
        clientTimeMs: Date.now(),
        clientManifestVersion,
        queueDepth,
      });
    },
  });
  const report = run.data;

  const blocking = report?.checks.filter((c) => c.blocking) ?? [];
  const informational = report?.checks.filter((c) => !c.blocking) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Offline preflight</h2>
          <p className="text-caption text-text-muted">
            An advisory check that a device is safe to enter offline mode. It never overrides the
            activation or readiness rules — the server stays authoritative.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Select
            id="pf-session"
            label="Session"
            value={activeSession}
            onChange={(e) => setSessionId(e.target.value)}
          >
            {event?.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {dateTime(s.startsAt)}
              </option>
            ))}
          </Select>
          <Select
            id="pf-device"
            label="Device"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          >
            <option value="">Select a device…</option>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.status})
              </option>
            ))}
          </Select>
          <Button
            className="mb-1"
            disabled={!deviceId || !activeSession}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            <RefreshCw className="h-4 w-4" /> Run checks
          </Button>
        </div>
      </div>

      {run.isError ? (
        <ErrorState message={errorMessage(run.error)} onRetry={() => run.mutate()} />
      ) : run.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !report ? (
        <Card>
          <p className="text-sm text-text-muted">
            Select a device and run the checks to see its offline readiness.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Verdict banner */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {(() => {
                  const V = VERDICT[report.verdict];
                  return <V.Icon className="h-8 w-8" aria-hidden />;
                })()}
                <div>
                  <p className="text-caption uppercase tracking-wide text-text-muted">
                    {report.deviceName}
                  </p>
                  <p className="text-h3 font-bold text-text-primary">
                    <Badge tone={VERDICT[report.verdict].tone}>
                      {VERDICT[report.verdict].label}
                    </Badge>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 print:hidden">
                <span className="text-caption text-text-muted">
                  Generated {dateTime(report.generatedAt)}
                </span>
                <Button variant="outline" size="sm" onClick={() => window.print()}>
                  <Printer className="h-3.5 w-3.5" /> Print
                </Button>
              </div>
            </div>
          </Card>

          <ChecklistCard
            title="Blocking checks"
            hint="A failure here means NOT READY."
            rows={blocking}
          />
          <ChecklistCard
            title="Informational checks"
            hint="Warnings to address, but they do not block."
            rows={informational}
          />
        </div>
      )}
    </div>
  );
}

function ChecklistCard({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: PreflightCheckRow[];
}) {
  return (
    <Card title={title} action={<span className="text-caption text-text-muted">{hint}</span>}>
      <ul className="divide-y divide-border">
        {rows.map((c) => (
          <li key={c.key} className="flex items-start gap-3 py-3">
            <StatusIcon status={c.status} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
                {c.label}
                <Badge tone={STATUS_TONE[c.status]}>{STATUS_TEXT[c.status]}</Badge>
                {c.blocking && <span className="text-caption text-text-muted">blocking</span>}
              </p>
              <p className="text-caption text-text-secondary">{c.explanation}</p>
              {c.guidance && <p className="text-caption text-action-primary">→ {c.guidance}</p>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
