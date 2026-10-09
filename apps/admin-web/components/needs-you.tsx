'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Info } from 'lucide-react';
import Link from 'next/link';
import {
  ACTION_QUEUES,
  api,
  Badge,
  Card,
  Skeleton,
  money,
  useAuthUser,
  type BadgeTone,
} from '@eticketsgo/web-kit';
import {
  attentionQueues,
  lastSevenDays,
  queueNoun,
  summarise,
  type AttentionItem,
  type AttentionQueue,
  type QueueOutcome,
} from '@/lib/attention';

/**
 * What needs a person, on the page an operator lands on.
 *
 * ── WHY IT LEADS THE PAGE ──────────────────────────────────────────────────────────
 * The admin console opened on ten measurements - gross merchandise value, platform revenue,
 * repeat-customer rate - and nothing that said what to do. Finding out whether work was
 * waiting meant opening seven pages in turn, so in practice nobody did it daily, and a refund
 * request or an organizer application could sit for a week without anybody being at fault.
 *
 * ── HOW THE COUNTS ARE GOT ─────────────────────────────────────────────────────────
 * From the queue endpoints that already exist, asking for one row and reading the total, not
 * from a new summary endpoint. Two reasons, and the second is the important one:
 *
 * 1. A separate count query is a second definition of "awaiting a decision" that will
 *    eventually disagree with the list it links to. This way the number and the page under it
 *    come from the same query, so they cannot.
 * 2. Each of those endpoints already carries its own capability. Asking for exactly the
 *    queues this operator holds means the authorization needs no second implementation here -
 *    and a queue that is not theirs is never requested, let alone refused.
 *
 * Which queues there are, and how their answers are sorted into "needs you", "clear" and
 * "for information", is `lib/attention.ts`, where it is tested without a browser.
 */
type Count = { count: number; note?: string };

/** One request per queue, each reading the total from the list the link goes to. */
function fetchCount(queue: AttentionQueue, now: Date): Promise<Count> {
  const one = { page: 1, pageSize: 1 };
  switch (queue.key) {
    case 'disputes':
      return api.admin.disputes().then((d) => ({
        count: d.disputes.length,
        /*
          How much is being disputed, per currency and never added across them. A chargeback
          queue of two is a different morning depending on whether it is for 400 rupees or
          four lakh, and the count alone cannot say which.
        */
        note: d.atRisk.length
          ? `${d.atRisk.map((a) => money(a.totalMinor, a.currency)).join(' + ')} at risk`
          : undefined,
      }));
    case 'refunds-requested':
      return api.admin
        .refunds({ ...one, status: 'REQUESTED' })
        .then((r) => ({ count: r.meta.total }));
    case 'refunds-failed':
      return api.admin.refunds({ ...one, status: 'FAILED' }).then((r) => ({ count: r.meta.total }));
    case 'payouts-failed':
      // This endpoint takes no filter and returns every payout at once, so the count is made
      // here. See the action-centre test, which records why this link carries no query.
      return api.admin
        .payouts()
        .then((rows) => ({ count: rows.filter((p) => p.status === 'FAILED').length }));
    case 'settlements-blocked':
      return api.admin.settlements
        .list({ ...one, status: 'BLOCKED' })
        .then((r) => ({ count: r.meta.total }));
    case 'reconciliation-open':
      // The discrepancy list is not paged; the count is the list the link opens on.
      return api.admin.finance.discrepancies('OPEN').then((rows) => ({ count: rows.length }));
    case 'organizers-pending':
      return api.admin
        .organizers({ ...one, status: 'PENDING' })
        .then((r) => ({ count: r.meta.total }));
    case 'events-review':
      return api.admin
        .events({ ...one, status: 'UNDER_REVIEW' })
        .then((r) => ({ count: r.meta.total }));
    case 'complaints-open':
      return api.admin
        .support({ ...one, kind: 'COMPLAINT', status: 'OPEN' })
        .then((r) => ({ count: r.meta.total }));
    case 'payments-failed-7d':
      return api.admin
        .payments({ ...one, status: 'FAILED', ...lastSevenDays(now) })
        .then((r) => ({ count: r.meta.total }));
    default:
      // A queue added without a count here would otherwise render as a permanent zero, which
      // reads as "nothing waiting" - the one thing this page must never say when it does not know.
      return Promise.reject(new Error(`No count defined for the "${queue.key}" queue.`));
  }
}

/*
  Severity is said in words as well as colour. A red bar and an amber bar are the same bar to
  somebody who cannot tell red from amber, and "Urgent" is not.
*/
const SEVERITY: Record<AttentionQueue['tone'], { word: string; badge: BadgeTone; bar: string }> = {
  critical: { word: 'Urgent', badge: 'error', bar: 'bg-status-error' },
  warning: { word: 'Action needed', badge: 'warning', bar: 'bg-status-warning' },
  normal: { word: 'Waiting for review', badge: 'info', bar: 'bg-status-info' },
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ActionTile({ item }: { item: AttentionItem }) {
  const { queue, outcome } = item;
  const sev = SEVERITY[queue.tone];
  const count = outcome.status === 'ok' ? outcome.count : 0;
  const note = outcome.status === 'ok' ? outcome.note : undefined;
  return (
    <li>
      <Link
        href={queue.href}
        data-queue={queue.key}
        className="group relative flex h-full flex-col gap-2 overflow-hidden rounded-lg border border-border bg-background-surface p-4 pl-5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className={`absolute inset-y-0 left-0 w-1 ${sev.bar}`} aria-hidden />
        <span className="flex items-start justify-between gap-3">
          <span className="text-h3 font-bold tabular-nums tracking-tight text-text-primary">
            {count}
          </span>
          <Badge tone={sev.badge}>{sev.word}</Badge>
        </span>
        <span className="text-[0.9375rem] font-semibold text-text-primary group-hover:underline">
          {capitalise(queueNoun(queue))}
        </span>
        <span className="text-sm text-text-secondary">{queue.consequence}</span>
        {note && <span className="text-caption font-medium text-text-primary">{note}</span>}
        <span className="mt-auto flex items-center gap-1 pt-1 text-caption font-medium text-action-primary">
          Open the queue <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

export function NeedsYou() {
  const { user, isLoading: userLoading } = useAuthUser();
  // One clock per mount, so the 7-day window in the label, the count and the link all agree.
  const now = useMemo(() => new Date(), []);
  const queues = useMemo(
    () => attentionQueues(ACTION_QUEUES, user?.adminPermissions, now),
    [user?.adminPermissions, now],
  );

  const results = useQueries({
    queries: queues.map((q) => ({
      queryKey: ['admin', 'action-centre', q.key],
      queryFn: () => fetchCount(q, now),
      // Work arrives while somebody is looking at the page, and a stale "nothing waiting" is
      // the one wrong answer that stops them looking again.
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: false,
    })),
  });

  if (userLoading) return <Skeleton className="h-32 w-full" />;

  /*
    ── NO DUTIES IS NOT AN EMPTY QUEUE ────────────────────────────────────────────────
    A back-office account holds named capabilities and a plain ADMIN role grants none of them
    by itself, so an account somebody created and has not yet given duties to is a real state
    and not a defensive branch. "Nothing is waiting" would tell them there is no work when the
    truth is that they cannot see any.
  */
  if (queues.length === 0) {
    return (
      <Card title="Needs you">
        <p className="text-sm text-text-secondary">
          Your account does not have any duties assigned yet, so there are no queues to show. This
          is not the same as there being no work. Ask a super admin to give your account the duties
          for your job.
        </p>
      </Card>
    );
  }

  const items: AttentionItem[] = queues.map((queue, i) => {
    const r = results[i];
    const outcome: QueueOutcome = r.isError
      ? { status: 'error' }
      : r.data
        ? { status: 'ok', count: r.data.count, note: r.data.note }
        : { status: 'loading' };
    return { queue, outcome };
  });
  const s = summarise(items);

  return (
    <div className="space-y-4">
      <Card
        title="Needs you"
        action={
          s.needsAction.length > 0 ? (
            <Badge tone="warning">
              {s.waiting} waiting in {s.needsAction.length}{' '}
              {s.needsAction.length === 1 ? 'queue' : 'queues'}
            </Badge>
          ) : undefined
        }
      >
        {s.needsAction.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Queues with work">
            {s.needsAction.map((item) => (
              <ActionTile key={item.queue.key} item={item} />
            ))}
          </ul>
        )}

        {s.loading.length > 0 && s.needsAction.length === 0 && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {s.loading.slice(0, 3).map((i) => (
              <Skeleton key={i.queue.key} className="h-32 w-full" />
            ))}
          </div>
        )}

        {/*
          "Nothing is waiting" is only said once every queue has actually answered. A queue still
          loading, or one that failed, cannot be reported as empty - that would be a guess printed
          as a fact, on the one screen whose whole job is to be trusted when it says so.
        */}
        {s.allChecked && s.needsAction.length === 0 && (
          <div className="flex items-center gap-3 text-sm">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-status-success" aria-hidden />
            <p className="text-text-secondary">
              Nothing is waiting in {s.clear.length === 1 ? 'your queue' : 'any of your queues'}.
              Checked just now.
            </p>
          </div>
        )}

        {s.unchecked.length > 0 && (
          <ul className={`space-y-2 ${s.needsAction.length > 0 ? 'mt-4' : ''}`}>
            {s.unchecked.map(({ queue }) => (
              <li
                key={queue.key}
                className="rounded-md border border-border bg-background-subtle px-3 py-2 text-sm"
              >
                <p className="font-medium text-text-primary">
                  We could not check {queueNoun(queue)}.
                </p>
                <p className="text-text-secondary">
                  Open it to see for yourself, rather than assume it is empty.{' '}
                  <Link href={queue.href} className="font-medium text-action-primary underline">
                    Go to the queue
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        )}

        {/*
          The empty queues, small and last. Eight cards of "0" is a page that has to be read to
          learn there is nothing to do; one row of links says the same and still lets somebody
          open a queue they want to look at anyway.
        */}
        {s.clear.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
              Clear
            </p>
            <ul className="flex flex-wrap gap-2">
              {s.clear.map(({ queue }) => (
                <li key={queue.key}>
                  <Link
                    href={queue.href}
                    data-queue={queue.key}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-caption text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-status-success" aria-hidden />
                    No {queueNoun(queue)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {s.info.length > 0 && (
        <Card title="For information">
          <ul className="space-y-2">
            {s.info.map(({ queue, outcome }) => (
              <li key={queue.key}>
                <Link
                  href={queue.href}
                  data-queue={queue.key}
                  className="group flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-status-info" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-text-primary group-hover:underline">
                      {outcome.status === 'ok'
                        ? capitalise(queue.label(outcome.count))
                        : outcome.status === 'error'
                          ? `We could not count ${queueNoun(queue)}`
                          : `Counting ${queueNoun(queue)}`}
                    </span>
                    <span className="block text-sm text-text-secondary">{queue.consequence}</span>
                  </span>
                  <Badge tone="neutral">No action needed</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
