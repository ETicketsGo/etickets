'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ban, Building2, CheckCircle2, Clock, HelpCircle } from 'lucide-react';
import { api, Card, Skeleton } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import {
  providerSummaryView,
  type ProviderSummaryView,
  type SummaryTone,
} from '@/lib/payout-provider-summary';

/**
 * Where this organizer's payouts stand, provider by provider.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────
 * A single state read from whichever payment-account row the server found first. With a Stripe
 * AND a Razorpay account on file it could describe the wrong one, and so contradict the panel
 * below it. The card now lists one line per provider and market the organizer uses (from
 * `GET /payouts/account-state`, `providers`), worst first, under a headline taken from the worst.
 *
 * ── THE SERVER DECIDES, THIS RENDERS ───────────────────────────────────────────────
 * This component reads no provider flag. The entries come from the same shared rules the Stripe
 * and Razorpay panels use, so a line here and the panel for that provider are the same answer.
 */

const ICON: Record<SummaryTone, typeof Clock> = {
  neutral: Building2,
  waiting: Clock,
  attention: AlertTriangle,
  stopped: Ban,
  good: CheckCircle2,
};

const TONE_CLASS: Record<SummaryTone, string> = {
  neutral: 'bg-background-subtle text-text-secondary',
  waiting: 'bg-tint-primary text-action-primary',
  attention: 'bg-tint-warning text-status-warning',
  good: 'bg-tint-success text-status-success',
  stopped: 'bg-tint-error text-status-error',
};

const PAYOUT_CLASS = {
  good: 'text-status-success',
  waiting: 'text-status-warning',
  bad: 'text-status-error',
} as const;

function Lines({ view }: { view: ProviderSummaryView }) {
  if (view.lines.length === 0) return null;
  return (
    <ul className="mt-4 space-y-2" aria-label="Payout setup by provider">
      {view.lines.map((l) => (
        <li
          key={l.key}
          data-testid={`payout-status-${l.key}`}
          className="rounded-md border border-border px-3 py-2"
        >
          <p className="font-medium text-text-primary">{l.title}</p>
          <dl className="mt-1 space-y-0.5 text-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-text-muted">Paid ticket sales:</dt>
              <dd className={l.paymentsBlocked ? 'text-status-error' : 'text-text-secondary'}>
                {l.payments}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-text-muted">Receiving payouts:</dt>
              <dd className={PAYOUT_CLASS[l.payoutsTone]}>{l.payouts}</dd>
            </div>
            {l.bank ? (
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-text-muted">Bank account:</dt>
                <dd className="text-text-secondary">{l.bank}</dd>
              </div>
            ) : null}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function PayoutStatus({ orgId }: { orgId: string }) {
  const { activeOrgSentenceName } = useOrg();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['organizer', 'payout-account-state', orgId],
    queryFn: () => api.payouts.accountState(orgId),
  });

  if (isLoading) {
    return (
      <div data-testid="payout-status">
        <Card title="Payout status">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-3 h-16 w-full" />
        </Card>
      </div>
    );
  }

  /*
    A failure is NOT a payout state. Rendering "no account" or "under review" because a request
    failed would be a reassuring lie about money; the honest answer is that we do not know.
  */
  if (isError || !data) {
    return (
      <div data-testid="payout-status">
        <Card title="Payout status">
          <div className="flex items-start gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE_CLASS.neutral}`}
            >
              <HelpCircle className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="font-semibold text-text-primary">We cannot check your payout status</p>
              <p className="mt-1 text-sm text-text-secondary">
                This is a problem reading the status, not a change to your account. Nothing about
                your payouts has changed.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-background-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-primary"
              >
                Try again
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const view = providerSummaryView(data);
  const Icon = ICON[view.tone];

  return (
    <div data-testid="payout-status">
      <Card title="Payout status">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE_CLASS[view.tone]}`}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-text-primary">{view.heading}</p>
            {/* Which organization this money belongs to: two can share a display name. */}
            <p className="mt-0.5 text-caption text-text-muted">For {activeOrgSentenceName}</p>
            <p className="mt-2 text-sm text-text-secondary">{view.detail}</p>
            <Lines view={view} />
          </div>
        </div>
      </Card>
    </div>
  );
}
