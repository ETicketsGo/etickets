'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  money,
} from '@eticketsgo/web-kit';
import { Figure, day } from '../../../components/billing/billing-ui';
import { BILLING_COPY, planWords, subscriptionStatusWords } from '../../../lib/billing';

const WINDOW_DAYS = 30;

/**
 * Billing & subscriptions: the overview.
 *
 * Counts and money as the API reports them, per currency. Two currencies are never added
 * together, and nothing here is an estimate: with no paid subscriptions every figure is zero
 * and the page says why.
 */
export default function BillingOverviewPage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState('');
  const metrics = useQuery({
    queryKey: ['admin', 'billing', 'metrics', WINDOW_DAYS],
    queryFn: () => api.admin.billing.metrics(WINDOW_DAYS),
  });
  const m = metrics.data;

  const open = (e: FormEvent) => {
    e.preventDefault();
    const id = orgId.trim();
    if (id) router.push(`/admin/billing/accounts/${encodeURIComponent(id)}`);
  };

  const statuses = Object.entries(m?.currentByStatus ?? {}).filter(([, n]) => n > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing & subscriptions"
        description="Organizer plans: who is on which plan, and what it earns. This is not ticket money."
        action={
          <ButtonLink href="/admin/billing/subscriptions" variant="outline">
            All subscriptions
          </ButtonLink>
        }
      />

      <Card title="Find an organization">
        <form onSubmit={open} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Input
              label="Organization id"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              hint="Opens that organization's plan, credits and invoices."
            />
          </div>
          <Button type="submit" disabled={!orgId.trim()}>
            Open
          </Button>
        </form>
        <p className="mt-3 text-caption text-text-muted">
          To find one by name, search the{' '}
          <Link className="underline underline-offset-2" href="/admin/billing/subscriptions">
            subscriptions list
          </Link>
          .
        </p>
      </Card>

      {metrics.isError ? (
        <ErrorState
          message="We could not load the billing figures."
          onRetry={() => metrics.refetch()}
        />
      ) : !m ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          {m.paidSubscriptions === 0 && (
            <p
              role="status"
              className="rounded-md border border-border bg-background-subtle p-3 text-sm text-text-secondary"
            >
              {BILLING_COPY.noPaid}
            </p>
          )}

          <section aria-labelledby="billing-now" className="space-y-3">
            <h2 id="billing-now" className="text-title font-semibold text-text-primary">
              Subscriptions now
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure label="Paid subscriptions" value={m.paidSubscriptions} />
              <Figure label="Trials" value={m.trials} />
              <Figure label="Free of charge" value={m.complimentary} hint="Given by staff" />
            </div>
            {statuses.length > 0 && (
              <p className="text-caption text-text-muted">
                By state:{' '}
                {statuses.map(([s, n]) => `${subscriptionStatusWords(s)} ${n}`).join(', ')}.
              </p>
            )}
          </section>

          <section aria-labelledby="billing-mrr" className="space-y-3">
            <h2 id="billing-mrr" className="text-title font-semibold text-text-primary">
              Monthly and yearly revenue
            </h2>
            <p className="text-caption text-text-muted">
              From paid subscriptions only. Each currency is shown on its own line.
            </p>
            {m.mrr.length === 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Figure label="Monthly recurring revenue" value={0} hint="No paid subscriptions" />
                <Figure label="Yearly recurring revenue" value={0} hint="No paid subscriptions" />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {m.mrr.map((r) => (
                  <Figure
                    key={r.currency}
                    label={`${r.currency}: monthly recurring revenue`}
                    value={money(r.mrrMinor, r.currency)}
                    hint={`Yearly ${money(r.arrMinor, r.currency)}. ${r.subscriptions} paid subscriptions.`}
                  />
                ))}
              </div>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Monthly revenue by plan">
              {m.mrrByPlan.length === 0 ? (
                <p className="text-sm text-text-secondary">None. No paid subscriptions.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-text-secondary">
                      <th className="py-1 font-medium">Plan</th>
                      <th className="py-1 font-medium">Subscriptions</th>
                      <th className="py-1 text-right font-medium">Monthly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.mrrByPlan.map((r) => (
                      <tr key={`${r.planCode}-${r.currency}`} className="border-t border-border">
                        <td className="py-1.5">{planWords(r.planCode)}</td>
                        <td className="py-1.5 tabular-nums">{r.subscriptions}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {money(r.mrrMinor, r.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title={`Paid invoices in the last ${m.windowDays} days`}>
              {m.revenueByPlan.length === 0 ? (
                <p className="text-sm text-text-secondary">None. No invoices were paid.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-text-secondary">
                      <th className="py-1 font-medium">Plan</th>
                      <th className="py-1 font-medium">Invoices</th>
                      <th className="py-1 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.revenueByPlan.map((r) => (
                      <tr key={`${r.planCode}-${r.currency}`} className="border-t border-border">
                        <td className="py-1.5">{planWords(r.planCode)}</td>
                        <td className="py-1.5 tabular-nums">{r.invoices}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {money(r.totalMinor, r.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-caption text-text-muted">
                From {day(m.from)} to {day(m.to)}.
              </p>
            </Card>
          </div>

          <Card title={`Cancellations in the last ${m.windowDays} days`}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure label="Cancelled" value={m.churn.cancellations} />
              <Figure label="Paid at the start" value={m.churn.paidAtStart} />
              <Figure
                label="Churn rate"
                value={
                  m.churn.rate == null ? 'Not enough data' : `${(m.churn.rate * 100).toFixed(1)}%`
                }
                hint={
                  m.churn.rate == null ? 'There were no paid subscriptions to lose.' : undefined
                }
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
