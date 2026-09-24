'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  PageHeader,
  Select,
  Skeleton,
  type AuditFilters,
  type AuditRow,
} from '@eticketsgo/web-kit';

/**
 * The audit log, with a way in.
 *
 * ── WHY THE FLAT LIST WAS THE PROBLEM ──────────────────────────────────────────────
 * Every privileged action on the platform, twenty rows to a page, newest first, filtered only by
 * action name. Correct and unusable: a confirmed booking in Vijayawada sat between a fee rule
 * change and a check-in in Hyderabad, and answering "what did this organizer do last week" meant
 * paging through everything that was not them.
 *
 * So the page opens on WHO rather than on WHAT. The panel lists the organizers active in the
 * window with a count each, grouped by the country they are registered in, and picking one
 * filters the list. The entries themselves are still one row per action - grouping them away
 * would destroy the record the log exists to keep - but they are now grouped under the day they
 * happened on, which is how somebody reads a log.
 *
 * ── WHAT THE COUNTRY HERE IS, AND IS NOT ───────────────────────────────────────────
 * The organizer's registered country. An audit row records an action, not a sale, so it has no
 * place of supply; nothing financial is derived from this grouping and the money reports do not
 * read it.
 */
const ISO = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = ISO(new Date());
const THIRTY_DAYS_AGO = ISO(new Date(Date.now() - 30 * 86_400_000));

/** A heading a person recognises: "Today", "Yesterday", then the date. */
function dayHeading(iso: string): string {
  const day = iso.slice(0, 10);
  if (day === TODAY) return 'Today';
  if (day === ISO(new Date(Date.now() - 86_400_000))) return 'Yesterday';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * "Ticket checked in", not "TICKET CHECKED IN".
 *
 * `titleCase` only replaces the underscores, so every action shouted in capitals - forty rows of
 * it down one column. An action is a sentence about something that happened, and it is read as
 * one.
 */
function actionLabel(action: string): string {
  const words = action.toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return action;
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * One entry.
 *
 * Laid out as a line rather than five table columns. The columns were action, entity, actor,
 * correlation id and time, which is what made this page - and most of the admin console - wider
 * than the screen. Read down the page it is: what happened, to what, who did it.
 */
function Entry({ row }: { row: AuditRow }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2.5 text-sm">
      {/* Wide enough for "02:58 AM" in one line: at w-12 the meridiem wrapped under the time. */}
      <span className="w-20 shrink-0 whitespace-nowrap tabular-nums text-text-muted">
        {timeOfDay(row.createdAt)}
      </span>
      <span className="font-medium text-text-primary">{actionLabel(row.action)}</span>
      <span className="text-text-secondary">
        {row.entityType}
        {row.entityId ? (
          <span className="ml-1 font-mono text-caption text-text-muted">
            {row.entityId.slice(0, 8)}
          </span>
        ) : null}
      </span>
      {row.organizationName && (
        <span className="text-text-secondary">· {row.organizationName}</span>
      )}
      <span className="text-caption text-text-muted">
        · {row.actor?.email ?? 'the platform itself'}
      </span>
      {row.correlationId && (
        <span className="font-mono text-caption text-text-muted" title="Correlation id">
          · {row.correlationId.slice(0, 8)}
        </span>
      )}
    </li>
  );
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AuditFilters>({ from: THIRTY_DAYS_AGO, to: TODAY });
  const set = (patch: AuditFilters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  /*
    The summary is asked WITHOUT the organization filter, so the panel keeps showing every
    organizer in the window after somebody picks one. A panel that narrows to the single row you
    just clicked gives you no way back to the others.
  */
  const summaryFilters: AuditFilters = {
    from: filters.from,
    to: filters.to,
    action: filters.action,
    entityType: filters.entityType,
  };
  const summary = useQuery({
    queryKey: ['admin', 'audit-summary', summaryFilters],
    queryFn: () => api.admin.auditSummary(summaryFilters),
  });

  const list = useQuery({
    queryKey: ['admin', 'audit', page, filters],
    queryFn: () => api.admin.audit({ page, pageSize: 50, ...filters }),
  });

  /** Organizers grouped under the country they are registered in, busiest country first. */
  const byCountry = useMemo(() => {
    const groups = new Map<string, { name: string; orgs: typeof rows }>();
    const rows = summary.data?.byOrganization ?? [];
    for (const org of rows) {
      const key = org.country ?? (org.organizationId ? 'Country not stated' : 'Platform');
      const found = groups.get(key);
      if (found) found.orgs.push(org);
      else groups.set(key, { name: key, orgs: [org] });
    }
    return [...groups.values()]
      .map((g) => ({ ...g, count: g.orgs.reduce((n, o) => n + o.count, 0) }))
      .sort((a, b) => b.count - a.count);
  }, [summary.data]);

  /** Entries grouped under their day, newest day first, in the order the API returned them. */
  const days = useMemo(() => {
    const groups: { day: string; rows: AuditRow[] }[] = [];
    for (const row of list.data?.data ?? []) {
      const day = row.createdAt.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last?.day === day) last.rows.push(row);
      else groups.push({ day, rows: [row] });
    }
    return groups;
  }, [list.data]);

  const activeOrg = summary.data?.byOrganization.find(
    (o) => o.organizationId === filters.organizationId,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every privileged action, as it was recorded. Nothing here can be edited or removed."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Input
            id="from"
            label="From"
            type="date"
            className="w-auto"
            value={filters.from ?? ''}
            max={filters.to ?? TODAY}
            onChange={(e) => set({ from: e.target.value })}
          />
          <Input
            id="to"
            label="To"
            type="date"
            className="w-auto"
            value={filters.to ?? ''}
            min={filters.from}
            max={TODAY}
            onChange={(e) => set({ to: e.target.value })}
          />
          <Select
            label="Action"
            className="w-auto min-w-[14rem]"
            value={filters.action ?? ''}
            onChange={(e) => set({ action: e.target.value || undefined })}
          >
            <option value="">Every action</option>
            {/* The actions the log actually holds, not a list typed into this page. */}
            {(summary.data?.actions ?? []).map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </Select>
          {(filters.organizationId || filters.action) && (
            <Button
              variant="ghost"
              onClick={() => set({ organizationId: undefined, action: undefined })}
            >
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <Card title="Who was active">
          {summary.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (summary.data?.byOrganization.length ?? 0) === 0 ? (
            <p className="text-sm text-text-secondary">Nothing was recorded in this window.</p>
          ) : (
            <div className="space-y-4">
              {byCountry.map((group) => (
                <div key={group.name}>
                  <p className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted">
                    {group.name} · {group.count}
                  </p>
                  <ul className="space-y-0.5">
                    {group.orgs.map((org) => {
                      const selected = org.organizationId === filters.organizationId;
                      return (
                        <li key={org.organizationId ?? 'platform'}>
                          <button
                            type="button"
                            aria-pressed={selected}
                            onClick={() =>
                              set({
                                organizationId: selected
                                  ? undefined
                                  : (org.organizationId ?? undefined),
                              })
                            }
                            className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                              selected
                                ? 'bg-tint-primary font-medium text-action-primary'
                                : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                            }`}
                          >
                            <span className="min-w-0 truncate">{org.name}</span>
                            <span className="flex shrink-0 items-center gap-1 tabular-nums text-text-muted">
                              {org.count}
                              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title={activeOrg ? `What ${activeOrg.name} did` : 'What happened'}
          action={
            list.data ? (
              <Badge tone="neutral">
                {list.data.meta.total} entr{list.data.meta.total === 1 ? 'y' : 'ies'}
              </Badge>
            ) : undefined
          }
        >
          {list.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : list.isError ? (
            <ErrorState message="We couldn't load this." onRetry={() => list.refetch()} />
          ) : days.length === 0 ? (
            <EmptyState
              title="Nothing recorded"
              hint="No privileged action matched these filters in this window."
            />
          ) : (
            <div className="space-y-5">
              {days.map((group) => (
                <div key={group.day}>
                  <p className="mb-1 border-b border-border pb-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted">
                    {dayHeading(group.day)}
                  </p>
                  <ul className="divide-y divide-border/60">
                    {group.rows.map((row) => (
                      <Entry key={row.id} row={row} />
                    ))}
                  </ul>
                </div>
              ))}
              {list.data && list.data.meta.totalPages > 1 && (
                <Pagination
                  page={list.data.meta.page}
                  totalPages={list.data.meta.totalPages}
                  onChange={setPage}
                />
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
