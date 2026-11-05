'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download, MailCheck, Repeat, Users } from 'lucide-react';
import {
  api,
  Button,
  Card,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  errorMessage,
  money,
  useToast,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { PURPOSE_WORDS, campaignGate, percent } from '@/lib/campaigns';
import {
  BarList,
  CampaignGateNotice,
  CampaignStatusChip,
  SeriesBars,
} from '@/components/campaigns/campaign-ui';

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

const SOURCE_LABELS: Record<string, string> = {
  ORGANIZER_PAGE: 'Your organizer page',
  BOOKING_CONFIRMATION: 'After booking',
  LOCAL_MIGRATION: 'Saved before sign-in',
};

/**
 * Campaign results and audience trends, over a date range. Aggregates only: no names, no
 * addresses, and any city or category with fewer than five people is hidden.
 */
export default function CampaignAnalyticsPage() {
  const { activeOrg } = useOrg();
  const toast = useToast();
  const [days, setDays] = useState(30);
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
  }, [days]);
  const status = useQuery({
    queryKey: ['campaigns-status', activeOrg.id],
    queryFn: () => api.campaigns.status(activeOrg.id),
  });
  const gate = campaignGate(status.data);
  const analyticsOn = gate.kind === 'ready' && !!status.data?.entitlements.analyticsBasic;
  const data = useQuery({
    queryKey: ['campaign-analytics', activeOrg.id, days],
    queryFn: () => api.campaigns.analytics(activeOrg.id, range),
    enabled: analyticsOn,
  });

  const header = (
    <PageHeader
      title="Campaign results"
      description="How your audience is growing and how your campaigns did. Counts only."
      action={
        analyticsOn ? (
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label="Date range"
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {RANGES.map((r) => (
                <option key={r.days} value={r.days}>
                  {r.label}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              icon={Download}
              onClick={async () => {
                try {
                  await api.campaigns.downloadAnalyticsCsv(activeOrg.id, range);
                } catch (err) {
                  toast.push(errorMessage(err), 'error');
                }
              }}
            >
              Export CSV
            </Button>
          </div>
        ) : undefined
      }
    />
  );

  if (status.isLoading) return <Skeleton className="h-96 w-full" />;
  if (gate.kind !== 'ready') {
    return (
      <div>
        {header}
        <CampaignGateNotice gate={gate} />
      </div>
    );
  }
  if (!analyticsOn) {
    return (
      <div>
        {header}
        <CampaignGateNotice
          gate={{
            kind: 'plan',
            title: 'Campaign results are part of the Pro and Premium plans',
            hint: 'Upgrade your plan to see how your campaigns did.',
          }}
        />
      </div>
    );
  }
  if (data.isLoading) {
    return (
      <div>
        {header}
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (data.isError || !data.data) {
    return (
      <div>
        {header}
        <ErrorState
          message="We could not load your results. Please try again."
          onRetry={() => data.refetch()}
        />
      </div>
    );
  }
  const o = data.data;
  const updates = o.subscribers.find((s) => s.purpose === 'ORGANIZER_UPDATES')?.subscribers ?? 0;

  return (
    <div className="space-y-6">
      {header}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Followers"
          value={o.followers.total.toLocaleString()}
          hint={`${o.followers.newInRange.toLocaleString()} new in this range`}
          icon={Users}
          tile="teal"
        />
        <StatCard
          label="Email subscribers"
          value={updates.toLocaleString()}
          hint={`${percent(o.optInRate)} of followers agreed to your event news`}
          icon={MailCheck}
          tile="purple"
        />
        <StatCard
          label="Returning customers"
          value={o.buyers.returningCustomers.toLocaleString()}
          hint={`${percent(o.buyers.repeatBuyerRate)} of ${o.buyers.buyers.toLocaleString()} buyers in this range had booked before`}
          icon={Repeat}
          tile="amber"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="New followers">
          <SeriesBars points={o.followers.series} label="New followers by period" />
        </Card>
        <Card title="Unsubscribes">
          <p className="mb-2 text-ui text-text-secondary">
            {o.unsubscribes.total.toLocaleString()} in this range.
          </p>
          <SeriesBars points={o.unsubscribes.series} label="Unsubscribes by period" />
        </Card>
        <Card title="Subscribers by kind of email">
          <BarList
            label="Subscribers by kind of email"
            rows={o.subscribers.map((s) => ({
              key: s.purpose,
              label: PURPOSE_WORDS[s.purpose]?.label ?? s.purpose,
              value: s.subscribers,
            }))}
          />
        </Card>
        <Card title="Where followers came from">
          <BarList
            label="Followers by source"
            rows={o.followers.bySource.map((s) => ({
              key: s.source,
              label: SOURCE_LABELS[s.source] ?? s.source,
              value: s.followers,
            }))}
          />
        </Card>
        <Card title="Buyers by city">
          <BarList
            label="Buyers by city"
            rows={o.cities.buckets.map((c) => ({
              key: `${c.city}-${c.country ?? ''}`,
              label: c.city,
              value: c.buyers,
            }))}
            emptyText={`No city has ${o.cities.threshold} or more buyers in this range.`}
          />
          {o.cities.hiddenBuckets > 0 && (
            <p className="mt-2 text-caption text-text-muted">
              {o.cities.hiddenBuckets} smaller{' '}
              {o.cities.hiddenBuckets === 1 ? 'city is' : 'cities are'} hidden to protect privacy.
            </p>
          )}
        </Card>
        <Card title="Buyers by category">
          <BarList
            label="Buyers by category"
            rows={o.categories.buckets.map((c) => ({
              key: c.category,
              label: c.category,
              value: c.buyers,
            }))}
            emptyText={`No category has ${o.categories.threshold} or more buyers in this range.`}
          />
        </Card>
      </div>

      <Card title="Campaigns in this range" padding="none">
        {o.campaigns.items.length === 0 ? (
          <p className="p-6 text-ui text-text-secondary">
            No campaigns in this range.{' '}
            <Link href="/organizer/campaigns/new" className="text-action-primary underline">
              Start one
            </Link>
            .
          </p>
        ) : (
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
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Delivered
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Clicked
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Click rate
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Unsubscribed
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Attributed bookings
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {o.campaigns.items.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/organizer/campaigns/${c.id}`}
                        className="font-medium text-text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <CampaignStatusChip status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.delivered.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.uniqueClicks.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{percent(c.clickRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.unsubscribed.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      {c.attributed === null
                        ? 'Premium plan'
                        : c.attributed.length === 0
                          ? 'None yet'
                          : c.attributed
                              .map(
                                (a) => `${a.orders} (${money(a.ticketRevenueMinor, a.currency)})`,
                              )
                              .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 pb-4 text-caption text-text-muted">
          Attributed means the person clicked the email and booked with you within{' '}
          {o.campaigns.windowDays} days. It does not mean the email caused the booking. Money is
          shown per currency and never added across currencies. We do not track opens.
        </p>
      </Card>
    </div>
  );
}
