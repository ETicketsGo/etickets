'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  api,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Input,
  MetricCard,
  PageHeader,
  Select,
  Skeleton,
  dateTime,
  errorMessage,
} from '@eticketsgo/web-kit';
import { OVERRIDE_LABEL, OVERRIDE_TONE } from '../live/seat-presentation';

/**
 * Seat override history for a cinema — who withheld what, and why.
 *
 * Read from the audit log rather than reconstructed from current seat state. A seat blocked
 * and then released leaves no trace in the inventory at all, so a report built from live rows
 * would be blind to exactly the question it exists to answer.
 */
export default function OverrideReportPage() {
  const { id: cinemaId } = useParams<{ id: string }>();
  const timezone = 'Asia/Kolkata';

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const weekAgo = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
    new Date(Date.now() - 7 * 86_400_000),
  );

  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [kindFilter, setKindFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');

  const reportQ = useQuery({
    queryKey: ['cinema', cinemaId, 'override-report', from, to],
    queryFn: () =>
      api.theaterOps.overrideReport(
        cinemaId,
        new Date(`${from}T00:00:00Z`).toISOString(),
        new Date(`${to}T23:59:59Z`).toISOString(),
      ),
  });

  const report = reportQ.data;

  // Filtering is client-side over an already-bounded window. The server caps at 500 and says
  // so; narrowing here does not hide that, because the banner is driven by the API's flag.
  const rows = useMemo(() => {
    if (!report) return [];
    return report.timeline.filter(
      (r) => (!kindFilter || r.kind === kindFilter) && (!actorFilter || r.actor === actorFilter),
    );
  }, [report, kindFilter, actorFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Seat override history"
        description="Every manual seat action at this cinema, with who made it and why."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="rep-from" className="mb-1 block text-sm font-medium">
              From
            </label>
            <Input
              id="rep-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="rep-to" className="mb-1 block text-sm font-medium">
              To
            </label>
            <Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label htmlFor="rep-kind" className="mb-1 block text-sm font-medium">
              Reason type
            </label>
            <Select
              id="rep-kind"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
            >
              <option value="">All types</option>
              {Object.entries(OVERRIDE_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="rep-actor" className="mb-1 block text-sm font-medium">
              Operator
            </label>
            <Select
              id="rep-actor"
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
            >
              <option value="">All operators</option>
              {(report?.byOperator ?? []).map((o) => (
                <option key={o.actor} value={o.actor}>
                  {o.actor}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      {reportQ.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : reportQ.isError ? (
        <ErrorState message={errorMessage(reportQ.error)} onRetry={() => void reportQ.refetch()} />
      ) : !report ? null : (
        <>
          {report.truncated ? (
            /*
              Never silent. A capped audit report that does not say so reads as "that is all
              that happened", which is the one impression it must never give.
            */
            <p role="status" className="rounded-md bg-status-warning/10 p-3 text-sm">
              This window hit the server limit, so older entries are not shown. Narrow the date
              range to see them.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Actions" value={String(report.totalActions)} />
            <MetricCard label="Seats withheld" value={String(report.seatsBlocked)} />
            <MetricCard label="Seats returned" value={String(report.seatsReleased)} />
          </div>

          {report.byKind.length > 0 ? (
            <Card title="By reason type">
              <div className="flex flex-wrap gap-2">
                {report.byKind.map((k) => (
                  <Badge key={k.kind} tone={OVERRIDE_TONE[k.kind]}>
                    {k.label}: {k.count}
                  </Badge>
                ))}
              </div>
            </Card>
          ) : null}

          {report.byReason.length > 0 ? (
            <Card title="Most common reasons">
              {/*
                Free text as entered. A fault recurring eleven times is a maintenance signal,
                not a data-entry problem, and normalising it away would hide that.
              */}
              <ul className="space-y-1 text-sm">
                {report.byReason.slice(0, 8).map((r) => (
                  <li key={r.reason} className="flex justify-between gap-4">
                    <span className="truncate">{r.reason}</span>
                    <span className="tabular-nums text-text-muted">{r.count} seats</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Timeline">
            {rows.length === 0 ? (
              <EmptyState
                title="No seat overrides in this window"
                hint="Widen the date range, or clear the filters."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Seat override actions, most recent first</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th scope="col" className="py-2 pr-4 font-medium">
                        When
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Operator
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Action
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Show
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Screen
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Seats
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.at}-${i}`} className="border-b border-border/50">
                        <td className="py-2 pr-4 whitespace-nowrap">{dateTime(r.at)}</td>
                        <td className="py-2 pr-4">{r.actor}</td>
                        <td className="py-2 pr-4">
                          {r.kind ? (
                            <Badge tone={OVERRIDE_TONE[r.kind]}>{OVERRIDE_LABEL[r.kind]}</Badge>
                          ) : (
                            <Badge tone="neutral">
                              {r.action === 'SHOW_SEATS_RELEASED_FORCED'
                                ? 'Released (forced)'
                                : 'Released'}
                            </Badge>
                          )}
                        </td>
                        <td className="py-2 pr-4">{r.movieTitle ?? '—'}</td>
                        <td className="py-2 pr-4">{r.screenName ?? '—'}</td>
                        <td className="py-2 pr-4 font-mono text-caption">
                          {r.seats.length > 0 ? r.seats.join(', ') : r.seatCount}
                        </td>
                        <td className="py-2">{r.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
