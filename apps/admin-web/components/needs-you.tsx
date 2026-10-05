'use client';

import { useQueries } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import {
  api,
  Card,
  Skeleton,
  money,
  queuesFor,
  useAuthUser,
  type ActionQueue,
} from '@eticketsgo/web-kit';

/**
 * What needs a person, on the page an operator lands on.
 *
 * ── WHY IT LEADS THE PAGE ──────────────────────────────────────────────────────────
 * The admin console opened on ten measurements - gross merchandise value, platform revenue,
 * repeat-customer rate - and nothing that said what to do. Finding out whether work was
 * waiting meant opening seven pages in turn, so in practice nobody did it daily, and a refund
 * request or an organizer application could sit for a week without anybody being at fault.
 *
 * The measurements still matter and they have not moved far; they are now below this. The
 * first thing on the screen is the work.
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
 */
type QueueResult = { count: number; note?: string };

/** One request per queue, each reading the total from the list the link goes to. */
function fetchCount(queue: ActionQueue): Promise<QueueResult> {
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
    default:
      // A queue added to the shared list without a count here would otherwise render as a
      // permanent zero, which reads as "nothing waiting" - the one thing this page must never
      // say when it does not know.
      return Promise.reject(new Error(`No count defined for the "${queue.key}" queue.`));
  }
}

const TONE: Record<ActionQueue['tone'], { dot: string; count: string }> = {
  critical: { dot: 'bg-status-error', count: 'text-status-error' },
  warning: { dot: 'bg-status-warning', count: 'text-status-warning' },
  normal: { dot: 'bg-action-primary', count: 'text-text-primary' },
};

export function NeedsYou() {
  const { user, isLoading: userLoading } = useAuthUser();
  const queues = queuesFor(user?.adminPermissions);

  const results = useQueries({
    queries: queues.map((q) => ({
      queryKey: ['admin', 'action-centre', q.key],
      queryFn: () => fetchCount(q),
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
    and not a defensive branch.

    It must not be answered with "Nothing is waiting". That tells somebody there is no work
    when the truth is they cannot see any, and it is indistinguishable from the platform
    being quiet - so they would stop checking.
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

  const loading = results.some((r) => r.isLoading);
  const rows = queues
    .map((queue, i) => ({ queue, result: results[i] }))
    .filter(({ result }) => (result.data?.count ?? 0) > 0 || result.isError);

  if (loading && rows.length === 0) {
    return (
      <Card title="Needs you">
        <Skeleton className="h-20 w-full" />
      </Card>
    );
  }

  /*
    An empty queue is not listed. Eight rows of "0" is a page that has to be read to learn
    that there is nothing to do, which is the problem this replaced. When every queue is
    empty the page says so in one line.

    "Nothing is waiting" is only said once every queue has actually answered. A queue still
    loading, or one that failed, cannot be reported as empty - that would be a guess printed
    as a fact, on the one screen whose whole job is to be trusted when it says there is
    nothing to do.
  */
  if (rows.length === 0 && !loading) {
    return (
      <Card title="Needs you">
        <div className="flex items-center gap-3 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-status-success" aria-hidden />
          <p className="text-text-secondary">
            Nothing is waiting in {queues.length === 1 ? 'your queue' : 'any of your queues'}.
            Checked just now.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Needs you">
      <ul className="divide-y divide-border">
        {rows.map(({ queue, result }) => {
          const tone = TONE[queue.tone];
          if (result.isError) {
            return (
              <li key={queue.key} className="py-3 text-sm">
                <p className="font-medium text-text-primary">
                  We could not check {queue.label(0).replace(/^0 /, '')}.
                </p>
                <p className="text-text-secondary">
                  Open it to see for yourself, rather than assume it is empty.{' '}
                  <Link href={queue.href} className="font-medium text-action-primary underline">
                    Go to the queue
                  </Link>
                </p>
              </li>
            );
          }
          const count = result.data?.count ?? 0;
          return (
            <li key={queue.key}>
              <Link
                href={queue.href}
                className="group flex items-start gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm font-semibold tabular-nums ${tone.count} group-hover:underline`}
                  >
                    {queue.label(count)}
                  </span>
                  <span className="block text-sm text-text-secondary">{queue.consequence}</span>
                  {result.data?.note && (
                    <span className="mt-0.5 block text-caption font-medium text-text-primary">
                      {result.data.note}
                    </span>
                  )}
                </span>
                <ArrowRight
                  className="mt-1 h-4 w-4 shrink-0 text-text-muted group-hover:text-action-primary"
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
