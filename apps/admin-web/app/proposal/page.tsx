'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import {
  ACTION_QUEUES,
  BRAND_FOCUS,
  MARKETS,
  api,
  money,
  useAuthUser,
  type BrandStatus,
} from '@eticketsgo/web-kit';
import { fetchCount } from '@/components/needs-you';
import {
  AsOf,
  LINK,
  PageHead,
  Panel,
  Pending,
  ProposalNote,
  State,
  Td,
  Th,
  Unread,
} from '@/components/proposal/desk';
import { attentionQueues, lastSevenDays, queueNoun, type AttentionQueue } from '@/lib/attention';
import { ageDays, ageWords, exposureByCurrency, oldest } from '@/lib/proposal-model';

/**
 * PROPOSAL - the admin overview as an operations desk (docs/design/ADMIN-PROPOSAL.md).
 *
 * Three questions, in the order a shift asks them, and nothing else on the page:
 *   1. What is waiting on a person, how much, and for how long?
 *   2. Does the money agree - per currency, never added?
 *   3. Where is the platform selling (for information)?
 *
 * Counts are the live dashboard's (`fetchCount`, the same total the queue's own list shows).
 * The age is new: the oldest row of the same list, read from its last page (every admin list
 * here is newest first), so it needs no new endpoint.
 */

const TONE: Record<AttentionQueue['tone'], { tone: BrandStatus; word: string }> = {
  critical: { tone: 'critical', word: 'Urgent' },
  warning: { tone: 'caution', word: 'Action needed' },
  normal: { tone: 'info', word: 'Waiting' },
};

/** The oldest item in a queue, or null where the list carries no usable date. */
async function oldestIn(queue: AttentionQueue, total: number, now: Date): Promise<string | null> {
  if (total === 0) return null;
  const last = { page: total, pageSize: 1 };
  switch (queue.key) {
    case 'disputes':
      return api.admin.disputes().then((d) => oldest(d.disputes.map((x) => x.createdAt)));
    case 'refunds-requested':
      return api.admin
        .refunds({ ...last, status: 'REQUESTED' })
        .then((r) => r.data[0]?.createdAt ?? null);
    case 'refunds-failed':
      return api.admin
        .refunds({ ...last, status: 'FAILED' })
        .then((r) => r.data[0]?.createdAt ?? null);
    case 'payouts-failed':
      return api.admin
        .payouts()
        .then((rows) => oldest(rows.filter((p) => p.status === 'FAILED').map((p) => p.createdAt)));
    case 'reconciliation-open':
      return api.admin.finance
        .discrepancies('OPEN')
        .then((rows) => oldest(rows.map((r) => r.createdAt)));
    case 'organizers-pending':
      return api.admin
        .organizers({ ...last, status: 'PENDING' })
        .then((r) => r.data[0]?.createdAt ?? null);
    case 'events-review':
      // The list carries no "submitted at"; the last change is the closest honest date.
      return api.admin
        .events({ ...last, status: 'UNDER_REVIEW' })
        .then((r) => r.data[0]?.updatedAt ?? null);
    case 'complaints-open':
      return api.admin
        .support({ ...last, kind: 'COMPLAINT', status: 'OPEN' })
        .then((r) => r.data[0]?.createdAt ?? null);
    case 'payments-failed-7d':
      return api.admin
        .payments({ ...last, status: 'FAILED', ...lastSevenDays(now) })
        .then((r) => r.data[0]?.createdAt ?? null);
    default:
      return null;
  }
}

function capitalise(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function marketName(country: string | null, currency: string) {
  const name = MARKETS.find((m) => m.code === country)?.name;
  return name ? `${name}, ${currency}` : currency;
}

export default function ProposalOverview() {
  const { user } = useAuthUser();
  const caps = useMemo(() => new Set(user?.adminPermissions ?? []), [user?.adminPermissions]);
  const now = useMemo(() => new Date(), []);
  const queues = useMemo(
    () => attentionQueues(ACTION_QUEUES, user?.adminPermissions, now),
    [user?.adminPermissions, now],
  );

  const counts = useQueries({
    queries: queues.map((q) => ({
      queryKey: ['proposal', 'count', q.key],
      queryFn: () => fetchCount(q, now),
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  const ages = useQueries({
    queries: queues.map((q, i) => ({
      queryKey: ['proposal', 'oldest', q.key, counts[i]?.data?.count ?? -1],
      queryFn: () => oldestIn(q, counts[i]!.data!.count, now),
      enabled: !!counts[i]?.data,
      staleTime: 30_000,
      retry: false,
    })),
  });

  const mayFinance = caps.has('FINANCE_READ');
  const mayFigures = caps.has('BOOKING_READ');
  const discrepancies = useQuery({
    queryKey: ['proposal', 'discrepancies', 'unresolved'],
    queryFn: async () => [
      ...(await api.admin.finance.discrepancies('OPEN')),
      ...(await api.admin.finance.discrepancies('ASSIGNED')),
    ],
    enabled: mayFinance,
  });
  const disputes = useQuery({
    queryKey: ['proposal', 'disputes'],
    queryFn: () => api.admin.disputes(),
    enabled: mayFinance,
  });
  const dash = useQuery({
    queryKey: ['proposal', 'dashboard'],
    queryFn: () => api.admin.dashboard(),
    enabled: mayFigures,
  });

  const rows = queues.map((queue, i) => ({ queue, count: counts[i], age: ages[i] }));
  const action = rows.filter((r) => r.queue.kind === 'action');
  const waiting = action.filter((r) => (r.count.data?.count ?? 0) > 0);
  const clear = action.filter((r) => r.count.data?.count === 0);
  const unread = action.filter((r) => r.count.isError);
  const info = rows.filter((r) => r.queue.kind === 'info');
  const loading = counts.some((c) => c.isLoading);
  const asOf = Math.max(0, ...counts.map((c) => c.dataUpdatedAt));
  const refresh = () => {
    counts.forEach((c) => void c.refetch());
    void discrepancies.refetch();
    void disputes.refetch();
    void dash.refetch();
  };

  const exposure = exposureByCurrency(discrepancies.data ?? []);
  const dateLine = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <>
      <ProposalNote />
      <PageHead
        eyebrow={dateLine}
        title="Overview"
        description="What is waiting on a person, then whether the money agrees. Every count opens the list it was read from."
        meta={<AsOf at={asOf || null} busy={loading} onRefresh={refresh} />}
      />

      {/* 1. The work */}
      <Panel
        id="work"
        title="Waiting on a decision"
        meta="Items in each of your queues right now, with how long the oldest has waited. Most costly to leave first."
      >
        {queues.length === 0 ? (
          <p className="text-brand-ui text-brand-ink-2">
            Your account has no duties yet, so there are no queues to show. This is not the same as
            there being no work. Ask a super admin for the duties of your job.
          </p>
        ) : loading ? (
          <Pending className="h-40" />
        ) : (
          <>
            {waiting.length > 0 ? (
              <ul className="-mx-4 divide-y divide-brand-line border-y border-brand-line sm:-mx-6">
                {waiting.map(({ queue, count, age }) => {
                  const n = count.data!.count;
                  const at = age.data ?? null;
                  const stale = at ? ageDays(at, now) >= 3 : false;
                  return (
                    <li key={queue.key}>
                      <Link
                        href={queue.href}
                        data-queue={queue.key}
                        className={`group grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1 px-4 py-4 hover:bg-brand-sunken sm:grid-cols-[5rem_minmax(0,1fr)_12rem_auto] sm:px-6 ${BRAND_FOCUS}`}
                      >
                        <span className="row-span-2 text-brand-figure tabular-nums text-brand-ink sm:row-span-1">
                          {n.toLocaleString('en-IN')}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-brand-ui font-semibold text-brand-ink group-hover:underline">
                            {capitalise(queue.label(n).replace(/^\d[\d,]* /, ''))}
                          </span>
                          <span className="block text-brand-meta text-brand-ink-2">
                            {queue.consequence}
                          </span>
                          {count.data?.note && (
                            <span className="block text-brand-meta font-semibold text-brand-ink">
                              {count.data.note}
                            </span>
                          )}
                        </span>
                        <span className="col-start-2 text-brand-meta text-brand-ink-2 sm:col-start-auto">
                          {age.isLoading ? (
                            'Reading age...'
                          ) : at ? (
                            <>
                              Oldest waiting{' '}
                              <span
                                className={`font-semibold ${stale ? 'text-brand-critical' : 'text-brand-ink'}`}
                              >
                                {ageWords(at, now)}
                              </span>
                              {queue.key === 'events-review' && ' (since last change)'}
                            </>
                          ) : (
                            'Age not reported'
                          )}
                        </span>
                        <span className="col-start-2 flex items-center gap-2 sm:col-start-auto sm:justify-end">
                          <State tone={TONE[queue.tone].tone}>{TONE[queue.tone].word}</State>
                          <ArrowRight
                            className="hidden h-4 w-4 text-brand-ink-3 sm:block"
                            aria-hidden
                          />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : unread.length === 0 ? (
              <p className="flex items-center gap-2 text-brand-ui font-semibold text-brand-positive">
                <CheckCircle2 className="h-5 w-5" aria-hidden /> Nothing is waiting in any of your
                queues.
              </p>
            ) : null}

            {unread.map(({ queue }) => (
              <p key={queue.key} className="mt-3 text-brand-ui text-brand-critical">
                We could not count {queueNoun(queue)}.{' '}
                <Link href={queue.href} className={LINK}>
                  Open the queue
                </Link>{' '}
                rather than assume it is empty.
              </p>
            ))}

            {clear.length > 0 && (
              <div className="mt-4">
                <p className="text-brand-eyebrow uppercase text-brand-ink-3">Clear</p>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {clear.map(({ queue }) => (
                    <li key={queue.key}>
                      <Link
                        href={queue.href}
                        className={`text-brand-meta text-brand-ink-2 hover:text-brand-ink hover:underline ${BRAND_FOCUS}`}
                      >
                        No {queueNoun(queue)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Panel>

      <div className="grid gap-8 2xl:grid-cols-2">
        {/* 2. Money integrity */}
        {mayFinance && (
          <Panel
            id="integrity"
            title="Does the money agree?"
            meta="Unresolved reconciliation exceptions and open chargebacks, per currency. Currencies are never added together."
            action={
              <Link href="/proposal/reconciliation" className={`${LINK} text-brand-meta`}>
                Reconciliation
              </Link>
            }
            flush
          >
            {discrepancies.isError ? (
              <div className="px-4 pb-4 sm:px-6">
                <Unread what="the reconciliation queue" onRetry={() => discrepancies.refetch()} />
              </div>
            ) : discrepancies.isLoading || disputes.isLoading ? (
              <div className="px-4 pb-4 sm:px-6">
                <Pending />
              </div>
            ) : (
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Money integrity by currency"
              >
                <table className="w-full">
                  <caption className="sr-only">
                    Unresolved exceptions and open chargebacks by currency
                  </caption>
                  <thead className="border-b border-brand-line">
                    <tr>
                      <Th>Currency</Th>
                      <Th right className="hidden sm:table-cell">
                        Exceptions
                      </Th>
                      <Th right>Amount in question</Th>
                      <Th right className="hidden sm:table-cell">
                        Oldest
                      </Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-line">
                    {exposure.length === 0 && (
                      <tr>
                        <Td className="text-brand-positive">
                          <span className="font-semibold">No unresolved exceptions.</span>
                        </Td>
                        <Td className="hidden sm:table-cell" />
                        <Td />
                        <Td className="hidden sm:table-cell" />
                      </tr>
                    )}
                    {exposure.map((g) => (
                      <tr key={g.currency ?? 'none'}>
                        <Td className="font-semibold">{g.currency ?? 'Not recorded'}</Td>
                        <Td right className="hidden sm:table-cell">
                          {g.count.toLocaleString('en-IN')}
                        </Td>
                        <Td right>
                          {g.currency ? money(g.amountMinor, g.currency) : 'Not shown'}
                          <span className="block text-brand-meta text-brand-ink-3 sm:hidden">
                            {g.count} exceptions
                            {g.oldestAt ? `, oldest ${ageWords(g.oldestAt, now)}` : ''}
                          </span>
                          {g.rowsWithoutAmount > 0 && (
                            <span className="block text-brand-meta text-brand-ink-3">
                              {g.rowsWithoutAmount} with no amount
                            </span>
                          )}
                        </Td>
                        <Td right className="hidden sm:table-cell">
                          {g.oldestAt ? ageWords(g.oldestAt, now) : '-'}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="border-t border-brand-line px-4 py-3 text-brand-meta text-brand-ink-2 sm:px-6">
                  {disputes.data && disputes.data.disputes.length > 0 ? (
                    <>
                      <span className="font-semibold text-brand-ink">
                        {disputes.data.disputes.length} open chargebacks
                      </span>
                      {disputes.data.atRisk.length > 0 &&
                        `: ${disputes.data.atRisk.map((a) => money(a.totalMinor, a.currency)).join(', ')} at risk`}
                      .{' '}
                      <Link href="/admin/disputes" className={LINK}>
                        Answer them
                      </Link>
                    </>
                  ) : disputes.isError ? (
                    'We could not read chargebacks.'
                  ) : (
                    'No open chargebacks.'
                  )}
                </div>
              </div>
            )}
          </Panel>
        )}

        {/* 3. For information */}
        {mayFigures && (
          <Panel
            id="markets"
            title="Where we sell"
            meta="Since launch, per currency. For information, not a queue."
            action={
              <Link href="/admin/reports" className={`${LINK} text-brand-meta`}>
                Reports
              </Link>
            }
            flush
          >
            {dash.isError ? (
              <div className="px-4 pb-4 sm:px-6">
                <Unread what="the platform figures" onRetry={() => dash.refetch()} />
              </div>
            ) : !dash.data ? (
              <div className="px-4 pb-4 sm:px-6">
                <Pending />
              </div>
            ) : (
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Sales by market"
              >
                <table className="w-full">
                  <caption className="sr-only">
                    Paid sales and bookings by market, since launch
                  </caption>
                  <thead className="border-b border-brand-line">
                    <tr>
                      <Th>Market</Th>
                      <Th right>Gross paid</Th>
                      <Th right className="hidden sm:table-cell">
                        Paid / all bookings
                      </Th>
                      <Th right className="hidden sm:table-cell">
                        Failed payments
                      </Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-line">
                    {(dash.data.money ?? []).map((m) => (
                      <tr key={m.currency}>
                        <Td className="whitespace-nowrap font-semibold">
                          {marketName(m.country, m.currency)}
                        </Td>
                        <Td right className="whitespace-nowrap">
                          {money(m.gmvMinor, m.currency)}
                        </Td>
                        <Td right className="hidden sm:table-cell">
                          {m.paidBookings.toLocaleString('en-IN')} /{' '}
                          {m.totalBookings.toLocaleString('en-IN')}
                        </Td>
                        <Td right className="hidden sm:table-cell">
                          {m.paymentFailures.toLocaleString('en-IN')}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="border-t border-brand-line px-4 py-3 text-brand-meta text-brand-ink-2 sm:px-6">
                  {info.map(({ queue, count }) => (
                    <li key={queue.key}>
                      {count.data ? (
                        <Link href={queue.href} className={`hover:underline ${BRAND_FOCUS}`}>
                          <span className="font-semibold tabular-nums text-brand-ink">
                            {count.data.count}
                          </span>{' '}
                          {queue.label(count.data.count).replace(/^\d[\d,]* /, '')}.{' '}
                          {queue.consequence}
                        </Link>
                      ) : count.isError ? (
                        `We could not count ${queueNoun(queue)}.`
                      ) : (
                        `Counting ${queueNoun(queue)}...`
                      )}
                    </li>
                  ))}
                  <li className="mt-1">
                    {dash.data.activeOrganizers} active organizers, {dash.data.publishedEvents}{' '}
                    published events, platform-wide, now.
                  </li>
                </ul>
              </div>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
