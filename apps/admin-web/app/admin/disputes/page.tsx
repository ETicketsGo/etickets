'use client';

import { useQuery } from '@tanstack/react-query';
import {
  api,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  Skeleton,
  StatusBadge,
  money,
  dateTime,
  type Column,
  type DisputeRow,
} from '@eticketsgo/web-kit';

/**
 * Open chargebacks.
 *
 * ── WHY THIS PAGE DID NOT EXIST ────────────────────────────────────────────────────
 * It should have. Every provider chargeback has been mirrored into the database since Stripe
 * Connect went in - amount, reason, the organizer, and the date the provider stops accepting
 * an answer - and the organizer's proceeds were blocked while it was open. There was no
 * controller and no screen, so the platform held a deadline it could not show anybody. The
 * only trace an operator got was a notification when it opened, which says a chargeback
 * happened and cannot answer which ones are still waiting on us.
 *
 * ── READ-ONLY, AND WHY THAT IS THE RIGHT ANSWER ────────────────────────────────────
 * Evidence is submitted in the provider's own dashboard, and the outcome comes back through
 * the webhook that already updates these rows. A "respond" button here would have to either
 * reimplement the provider's evidence model or pretend to, and a button that pretends to
 * answer a chargeback is worse than no button at all: somebody would press it and stop.
 *
 * So this page does the one thing that was missing - says what is open, what it is worth and
 * when it is due - and says plainly where the answer is given.
 */

/** How close the deadline is, in words, because "2026-10-09T00:00:00Z" is not a deadline. */
function dueIn(evidenceDueBy: string | null): {
  text: string;
  tone: 'error' | 'warning' | 'muted';
} {
  if (!evidenceDueBy) return { text: 'No deadline set', tone: 'muted' };
  const ms = new Date(evidenceDueBy).getTime() - Date.now();
  const days = Math.floor(ms / 86_400_000);
  if (ms < 0) return { text: 'Deadline passed', tone: 'error' };
  if (days === 0) return { text: 'Due today', tone: 'error' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'error' };
  if (days <= 3) return { text: `Due in ${days} days`, tone: 'error' };
  if (days <= 7) return { text: `Due in ${days} days`, tone: 'warning' };
  return { text: `Due in ${days} days`, tone: 'muted' };
}

const TONE_CLASS = {
  error: 'font-semibold text-status-error',
  warning: 'font-semibold text-status-warning',
  muted: 'text-text-secondary',
} as const;

export default function DisputesPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'disputes'],
    queryFn: () => api.admin.disputes(),
  });

  const columns: Column<DisputeRow>[] = [
    {
      key: 'evidenceDueBy',
      header: 'Deadline',
      render: (d) => {
        const due = dueIn(d.evidenceDueBy);
        return (
          <div>
            <span className={`block text-sm ${TONE_CLASS[due.tone]}`}>{due.text}</span>
            {d.evidenceDueBy && (
              <span className="block text-caption text-text-muted">
                {dateTime(d.evidenceDueBy)}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'amountMinor',
      header: 'Amount',
      render: (d) => <span className="tabular-nums">{money(d.amountMinor, d.currency)}</span>,
    },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.status} /> },
    {
      key: 'reason',
      header: 'Reason',
      render: (d) => (
        <span className="text-text-secondary">{d.reason ?? 'Not given by the provider'}</span>
      ),
    },
    {
      key: 'organization',
      header: 'Organizer',
      render: (d) =>
        d.organization ? (
          <a
            href={`/admin/organizers/${d.organization.id}`}
            className="font-medium text-action-primary underline"
          >
            {d.organization.name}
          </a>
        ) : (
          // The provider sends disputes against the platform account; one we cannot trace to a
          // booking has no organizer, and saying so beats an empty cell.
          <span className="text-text-muted">Not traced to an organizer</span>
        ),
    },
    {
      key: 'providerDisputeId',
      header: 'Provider reference',
      render: (d) => (
        <span className="text-caption text-text-muted">
          {d.provider} · {d.providerDisputeId}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chargebacks"
        description="Disputes the provider is still waiting on us for, soonest deadline first."
      />

      <Card title="How a chargeback is answered">
        <p className="text-sm text-text-secondary">
          Evidence goes to the payment provider, in the provider&apos;s own dashboard, using the
          provider reference in the last column. The result comes back here on its own. This page is
          here so that no deadline passes without somebody seeing it: if the date passes with no
          answer, the chargeback is lost and the money is gone.
        </p>
      </Card>

      {isError ? (
        <ErrorState message="We couldn't load the chargebacks." onRetry={() => refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !data || data.disputes.length === 0 ? (
        <EmptyState
          title="No open chargebacks"
          hint="A disputed payment appears here as soon as the provider tells us about it."
        />
      ) : (
        <>
          {/*
            One card per currency, never a total. Rupees added to dollars is not an amount of
            anything - the same rule the platform overview had to be fixed for.
          */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.atRisk.map((a) => (
              <MetricCard
                key={a.currency}
                label={`At risk, ${a.currency}`}
                value={money(a.totalMinor, a.currency)}
                hint="Disputed and not yet decided"
                tone="error"
              />
            ))}
          </div>
          <DataTable columns={columns} rows={data.disputes} rowKey={(d) => d.id} />
        </>
      )}
    </div>
  );
}
