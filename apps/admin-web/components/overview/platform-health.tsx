'use client';

import { useQuery } from '@tanstack/react-query';
import { Database, Layers, Server, type LucideIcon } from 'lucide-react';
import {
  api,
  ErrorState,
  IconTile,
  SectionCard,
  SectionLink,
  Skeleton,
  StatusPill,
  type PillTone,
} from '@eticketsgo/web-kit';

const TONE: Record<string, PillTone> = {
  up: 'success',
  ok: 'success',
  degraded: 'warning',
  down: 'error',
};

const WORD: Record<string, string> = {
  up: 'Up',
  ok: 'Normal',
  degraded: 'Degraded',
  down: 'Down',
};

function Row({
  icon,
  label,
  status,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  status: string;
  detail?: string;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <IconTile icon={icon} tone="neutral" size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-text-primary">{label}</span>
        {detail && (
          <span className="block truncate text-caption tabular-nums text-text-muted">{detail}</span>
        )}
      </span>
      <StatusPill tone={TONE[status] ?? 'neutral'} size="sm">
        {WORD[status] ?? status}
      </StatusPill>
    </li>
  );
}

/**
 * Platform health, from `GET /admin/ops/health` - the same request, and the same cache entry,
 * as the Operations page, so the two cannot disagree. Shown only to an operator with OPS_READ;
 * the parent decides. Storage is left out: it reports "not configured" by design (images live
 * in Postgres), and a permanent grey row teaches people to skip the card.
 */
export function PlatformHealth() {
  const health = useQuery({
    queryKey: ['admin', 'ops', 'health'],
    queryFn: () => api.admin.opsHealth(),
    refetchInterval: 30_000,
  });
  const h = health.data;
  return (
    <SectionCard
      title="Platform health"
      description={h ? `Environment: ${h.appEnv ?? h.nodeEnv}` : undefined}
      action={
        <SectionLink href="/admin/ops" srLabel="operations">
          Operations
        </SectionLink>
      }
    >
      {health.isLoading ? (
        <Skeleton className="h-36 w-full" />
      ) : health.isError || !h ? (
        <ErrorState
          message="We could not check platform health."
          onRetry={() => health.refetch()}
        />
      ) : (
        <>
          <div
            className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 text-ui font-semibold ${
              h.status === 'ok'
                ? 'bg-tint-success text-status-success'
                : 'bg-tint-warning text-status-warning'
            }`}
          >
            {h.status === 'ok' ? 'All checks are normal' : 'Something needs a look'}
          </div>
          <ul className="mt-1 divide-y divide-border">
            <Row
              icon={Database}
              label="Database"
              status={h.database.status}
              detail={`${h.database.latencyMs} ms`}
            />
            <Row
              icon={Server}
              label="Redis"
              status={h.redis.status}
              detail={`${h.redis.latencyMs} ms`}
            />
            <Row
              icon={Layers}
              label="Job queue"
              status={h.queue.status}
              detail={
                h.queue.recentFailed
                  ? `${h.queue.recentFailed} failed in the last 24 hours`
                  : `${h.queue.latencyMs} ms`
              }
            />
          </ul>
        </>
      )}
    </SectionCard>
  );
}
