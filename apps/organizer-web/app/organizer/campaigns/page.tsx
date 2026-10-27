'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Mail, Plus } from 'lucide-react';
import {
  api,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  dateTime,
  type CampaignStatus,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { isForbidden } from '@/lib/org-permissions';
import { STATUS_FILTERS, campaignGate } from '@/lib/campaigns';
import { CampaignGateNotice, CampaignStatusChip } from '@/components/campaigns/campaign-ui';

/**
 * Email campaigns: the list, with a filter by status.
 *
 * A campaign goes only to people who agreed to that kind of email from this organizer. The page
 * never lists recipients: the API never returns one.
 */
export default function CampaignsPage() {
  const { activeOrg } = useOrg();
  const [filter, setFilter] = useState<CampaignStatus | 'ALL'>('ALL');
  const status = useQuery({
    queryKey: ['campaigns-status', activeOrg.id],
    queryFn: () => api.campaigns.status(activeOrg.id),
    retry: (n, e) => !isForbidden(e) && n < 2,
  });
  const gate = campaignGate(status.data);
  const list = useQuery({
    queryKey: ['campaigns', activeOrg.id, filter],
    queryFn: () =>
      api.campaigns.list(activeOrg.id, filter === 'ALL' ? {} : { status: filter, pageSize: 50 }),
    enabled: gate.kind === 'ready',
  });

  const header = (
    <PageHeader
      title="Email campaigns"
      description="Email the people who agreed to hear from you. We never show you who they are."
      action={
        gate.kind === 'ready' ? (
          <Link
            href="/organizer/campaigns/new"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-action-primary px-5 text-ui font-semibold text-action-primary-foreground hover:bg-action-primary-hover"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New campaign
          </Link>
        ) : undefined
      }
    />
  );

  if (status.isLoading) {
    return (
      <div>
        {header}
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div>
        {header}
        <ErrorState
          message={
            isForbidden(status.error)
              ? 'Only owners and managers can use email campaigns.'
              : 'We could not load your campaigns. Please try again.'
          }
          onRetry={isForbidden(status.error) ? undefined : () => status.refetch()}
        />
      </div>
    );
  }
  if (gate.kind !== 'ready') {
    return (
      <div>
        {header}
        <CampaignGateNotice gate={gate} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {status.data?.quota && (
        <p className="text-ui text-text-secondary" data-testid="campaign-quota">
          {status.data.quota.remaining.toLocaleString()} emails left this month on your plan.
        </p>
      )}
      {status.data && !status.data.sending.allowed && (
        <p className="rounded-md bg-tint-warning p-3 text-ui text-status-warning">
          {status.data.sending.refusal}
        </p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`min-h-9 rounded-full border px-3 text-ui ${
              filter === f.value
                ? 'border-action-primary bg-tint-primary text-action-primary'
                : 'border-border text-text-secondary hover:bg-background-subtle'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {list.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : list.isError ? (
        <ErrorState message="We could not load your campaigns." onRetry={() => list.refetch()} />
      ) : !list.data?.items.length ? (
        <EmptyState
          icon={Mail}
          tone="purple"
          title={filter === 'ALL' ? 'No campaigns yet' : 'No campaigns with this status'}
          hint="Start with a template: a new event, early-bird tickets, an offer or a thank-you."
          action={
            <Link
              href="/organizer/campaigns/new"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-action-primary px-5 text-ui font-semibold text-action-primary-foreground hover:bg-action-primary-hover"
            >
              New campaign
            </Link>
          }
        />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-ui">
              <thead className="text-caption text-text-secondary">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Campaign
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Sent to
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.data.items.map((c) => {
                  const sentTo =
                    (c.counters?.ACCEPTED ?? 0) +
                    (c.counters?.DELIVERED ?? 0) +
                    (c.counters?.DEFERRED ?? 0) +
                    (c.counters?.BOUNCED ?? 0) +
                    (c.counters?.COMPLAINED ?? 0) +
                    (c.counters?.UNSUBSCRIBED ?? 0);
                  const when = c.completedAt ?? c.startedAt ?? c.scheduledAt ?? c.updatedAt;
                  const href =
                    c.status === 'DRAFT'
                      ? `/organizer/campaigns/${c.id}/edit`
                      : `/organizer/campaigns/${c.id}`;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-3">
                        <Link href={href} className="font-medium text-text-primary hover:underline">
                          {c.name}
                        </Link>
                        <p className="text-caption text-text-muted">{c.subject}</p>
                      </td>
                      <td className="px-4 py-3">
                        <CampaignStatusChip status={c.status} />
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{dateTime(when)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {c.status === 'DRAFT' || c.status === 'SCHEDULED'
                          ? '-'
                          : sentTo.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
