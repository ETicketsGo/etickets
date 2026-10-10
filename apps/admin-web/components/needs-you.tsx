'use client';

import { useEffect, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  ArrowRight,
  Banknote,
  Building2,
  CalendarCheck2,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  Inbox,
  Landmark,
  MessageSquareWarning,
  RotateCcw,
  Scale,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import {
  ACTION_QUEUES,
  api,
  IconTile,
  SectionCard,
  SkeletonCard,
  StatusPill,
  money,
  useAuthUser,
  type PillTone,
  type TileTone,
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
  Severity is said in words as well as colour. A red tile and an amber tile are the same tile to
  somebody who cannot tell red from amber, and "Urgent" is not.
*/
const SEVERITY: Record<AttentionQueue['tone'], { word: string; pill: PillTone; tile: TileTone }> = {
  critical: { word: 'Urgent', pill: 'error', tile: 'rose' },
  warning: { word: 'Action needed', pill: 'warning', tile: 'amber' },
  normal: { word: 'Waiting for review', pill: 'info', tile: 'blue' },
};

/** What each queue is about, as an icon. A queue added without one gets the generic inbox. */
const QUEUE_ICON: Record<string, LucideIcon> = {
  disputes: ShieldAlert,
  'refunds-requested': RotateCcw,
  'refunds-failed': CircleAlert,
  'payouts-failed': Banknote,
  'settlements-blocked': Landmark,
  'reconciliation-open': Scale,
  'organizers-pending': Building2,
  'events-review': CalendarCheck2,
  'complaints-open': MessageSquareWarning,
  'payments-failed-7d': CreditCard,
};

function iconFor(queue: AttentionQueue): LucideIcon {
  return QUEUE_ICON[queue.key] ?? Inbox;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * A queue with work in it, as a stat card: the pastel tile says what kind of work, the number
 * is the size of the queue, the pill says how much delay costs, and the sentence says what
 * happens if it is left. The whole card is the link, and it lands on the filtered list.
 */
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
        className={`group flex h-full flex-col gap-3 rounded-lg border border-border bg-background-surface p-5 shadow-xs transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${FOCUS} focus-visible:ring-offset-2`}
      >
        <span className="flex items-start justify-between gap-3">
          <IconTile icon={iconFor(queue)} tone={sev.tile} size="lg" />
          <StatusPill tone={sev.pill} size="sm">
            {sev.word}
          </StatusPill>
        </span>
        <span className="block">
          <span className="block font-display text-[1.75rem] font-bold leading-none tracking-tight tabular-nums text-text-primary">
            {count}
          </span>
          <span className="mt-1.5 block text-ui font-semibold text-text-primary group-hover:underline">
            {capitalise(queueNoun(queue))}
          </span>
        </span>
        <span className="text-caption text-text-secondary">{queue.consequence}</span>
        {note && <span className="text-caption font-semibold text-text-primary">{note}</span>}
        <span className="mt-auto inline-flex items-center gap-1 text-caption font-semibold text-action-primary">
          Open the queue <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

export function NeedsYou({
  onSettled,
}: {
  /**
   * Told once every queue has answered (or failed) for the first time, so the page can paint
   * itself once instead of growing as each count lands. Later refetches do not call it again.
   */
  onSettled?: () => void;
} = {}) {
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
  const settled = !userLoading && items.every((i) => i.outcome.status !== 'loading');
  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled, onSettled]);

  if (userLoading) return <SkeletonCard variant="stat" />;

  /*
    ── NO DUTIES IS NOT AN EMPTY QUEUE ────────────────────────────────────────────────
    A back-office account holds named capabilities and a plain ADMIN role grants none of them
    by itself, so an account somebody created and has not yet given duties to is a real state
    and not a defensive branch. "Nothing is waiting" would tell them there is no work when the
    truth is that they cannot see any.
  */
  if (queues.length === 0) {
    return (
      <SectionCard title="Needs you">
        <p className="text-sm text-text-secondary">
          Your account does not have any duties assigned yet, so there are no queues to show. This
          is not the same as there being no work. Ask a super admin to give your account the duties
          for your job.
        </p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="Needs you"
        description="Queues that wait on a decision, most costly to leave first."
        action={
          s.needsAction.length > 0 ? (
            <StatusPill tone="warning">
              {s.waiting} waiting in {s.needsAction.length}{' '}
              {s.needsAction.length === 1 ? 'queue' : 'queues'}
            </StatusPill>
          ) : undefined
        }
      >
        {s.needsAction.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3" aria-label="Queues with work">
            {s.needsAction.map((item) => (
              <ActionTile key={item.queue.key} item={item} />
            ))}
          </ul>
        )}

        {s.loading.length > 0 && s.needsAction.length === 0 && (
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {s.loading.slice(0, 3).map((i) => (
              <SkeletonCard key={i.queue.key} variant="stat" />
            ))}
          </div>
        )}

        {/*
          "Nothing is waiting" is only said once every queue has actually answered. A queue still
          loading, or one that failed, cannot be reported as empty - that would be a guess printed
          as a fact, on the one screen whose whole job is to be trusted when it says so.
        */}
        {s.allChecked && s.needsAction.length === 0 && (
          <div className="flex items-center gap-3 rounded-lg bg-tint-success px-4 py-3 text-sm">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-status-success" aria-hidden />
            <p className="font-medium text-text-primary">
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
                className="flex items-start gap-3 rounded-lg border border-border bg-background-subtle px-4 py-3 text-sm"
              >
                <IconTile icon={CircleAlert} tone="amber" size="sm" />
                <span className="min-w-0">
                  <span className="block font-semibold text-text-primary">
                    We could not check {queueNoun(queue)}.
                  </span>
                  <span className="block text-text-secondary">
                    Open it to see for yourself, rather than assume it is empty.{' '}
                    <Link
                      href={queue.href}
                      className={`rounded-sm font-semibold text-action-primary underline ${FOCUS}`}
                    >
                      Go to the queue
                    </Link>
                  </span>
                </span>
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
          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2.5 text-micro font-semibold uppercase tracking-wide text-text-muted">
              Clear
            </p>
            <ul className="flex flex-wrap gap-2">
              {s.clear.map(({ queue }) => (
                <li key={queue.key}>
                  <Link
                    href={queue.href}
                    data-queue={queue.key}
                    className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-background-surface px-3 py-1 text-caption text-text-secondary transition-colors duration-150 hover:bg-background-subtle hover:text-text-primary ${FOCUS}`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-status-success" aria-hidden />
                    No {queueNoun(queue)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>

      {s.info.length > 0 && (
        <SectionCard title="For information">
          <ul className="space-y-2">
            {s.info.map(({ queue, outcome }) => (
              <li key={queue.key}>
                <Link
                  href={queue.href}
                  data-queue={queue.key}
                  className={`group flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md py-1 ${FOCUS}`}
                >
                  <IconTile icon={iconFor(queue)} tone="neutral" size="md" />
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block text-sm font-semibold text-text-primary group-hover:underline">
                      {outcome.status === 'ok'
                        ? capitalise(queue.label(outcome.count))
                        : outcome.status === 'error'
                          ? `We could not count ${queueNoun(queue)}`
                          : `Counting ${queueNoun(queue)}`}
                    </span>
                    <span className="block text-caption text-text-secondary">
                      {queue.consequence}
                    </span>
                  </span>
                  <StatusPill tone="neutral" size="sm" dot={false}>
                    No action needed
                  </StatusPill>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
