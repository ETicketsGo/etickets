'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import {
  api,
  Card,
  MetricCard,
  DataTable,
  StatusBadge,
  Badge,
  Skeleton,
  ErrorState,
  PageHeader,
  money,
  type Column,
  type RiskSignal,
} from '@eticketsgo/web-kit';

const SEV_TONE: Record<string, 'error' | 'warning' | 'neutral'> = {
  high: 'error',
  medium: 'warning',
  low: 'neutral',
};

export default function AiConsolePage() {
  const statusQ = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api.admin.aiStatus() });
  const usageQ = useQuery({ queryKey: ['ai', 'usage'], queryFn: () => api.admin.aiUsage() });
  const riskQ = useQuery({ queryKey: ['ai', 'risk'], queryFn: () => api.admin.aiRisk() });

  const riskCols: Column<RiskSignal>[] = [
    {
      key: 'sev',
      header: 'Severity',
      render: (r) => <Badge tone={SEV_TONE[r.severity]}>{r.severity}</Badge>,
    },
    { key: 'title', header: 'Signal', render: (r) => r.title },
    { key: 'evidence', header: 'Evidence', render: (r) => r.evidence },
    { key: 'rec', header: 'Suggested review', render: (r) => r.recommendation },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="AI Console" />

      {/* Provider status */}
      <Card title="Provider status">
        {statusQ.isError ? (
          <ErrorState message="Couldn't load status." onRetry={() => statusQ.refetch()} />
        ) : statusQ.isLoading || !statusQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={statusQ.data.enabled ? 'ENABLED' : 'DISABLED'} />
              <span className="text-sm text-text-secondary">
                Provider:{' '}
                <span className="font-medium text-text-primary">{statusQ.data.provider}</span>
                {statusQ.data.model ? ` · ${statusQ.data.model}` : ''}
              </span>
              <span className="text-caption text-text-muted">
                timeout {statusQ.data.timeoutMs}ms · retries {statusQ.data.maxRetries}
              </span>
            </div>
            {!statusQ.data.enabled && (
              <p className="rounded-lg border border-border bg-background-subtle px-3 py-2 text-caption text-text-muted">
                AI is disabled. All features run on deterministic insights — no external provider is
                called.
              </p>
            )}
            <div>
              <p className="mb-1 text-caption font-semibold text-text-secondary">Prompt versions</p>
              <ul className="flex flex-wrap gap-2">
                {statusQ.data.prompts.map((p) => (
                  <li
                    key={p.key}
                    className="rounded-full bg-background-subtle px-2.5 py-0.5 text-caption text-text-muted"
                  >
                    {p.key} @ {p.version}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>

      {/* Usage / telemetry */}
      <Card title="Usage (last 30 days)">
        {usageQ.isLoading || !usageQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Requests" value={usageQ.data.totalRequests} />
            <MetricCard
              label="Fallback rate"
              value={`${usageQ.data.fallbackRate}%`}
              tone={usageQ.data.fallbackRate > 50 ? 'warning' : 'neutral'}
            />
            <MetricCard label="Avg latency" value={`${usageQ.data.avgLatencyMs}ms`} />
            <MetricCard
              label="Errors"
              value={usageQ.data.errorCount}
              tone={usageQ.data.errorCount > 0 ? 'warning' : 'neutral'}
            />
            <MetricCard label="Est. cost" value={money(usageQ.data.estimatedCostMinor)} />
            <MetricCard label="PII redactions" value={usageQ.data.safetyRedactions} />
          </div>
        )}
      </Card>

      {/* Risk signals */}
      <Card title="Risk signals">
        <div className="mb-3 flex items-center gap-2 text-caption text-text-muted">
          <ShieldAlert className="h-4 w-4" /> Advisory only — no automated action is taken.
        </div>
        {riskQ.isError ? (
          <ErrorState message="Couldn't load risk signals." onRetry={() => riskQ.refetch()} />
        ) : riskQ.isLoading || !riskQ.data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <DataTable
            columns={riskCols}
            rows={riskQ.data.signals}
            rowKey={(r) => r.key}
            empty={
              <p className="p-4 text-sm text-text-muted">
                No risk signals in the {riskQ.data.windowLabel}.
              </p>
            }
          />
        )}
      </Card>
    </div>
  );
}
