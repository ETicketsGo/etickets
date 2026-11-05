'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  Button,
  Card,
  ErrorState,
  PageHeader,
  Skeleton,
  dateTime,
  errorMessage,
  money,
  useToast,
  type Campaign,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { PURPOSE_WORDS, campaignGate, pausedReasonText, percent } from '@/lib/campaigns';
import { CampaignGateNotice, CampaignStatusChip } from '@/components/campaigns/campaign-ui';

const LIVE = new Set(['QUEUED', 'SENDING']);

const HISTORY_WORDS: Record<string, string> = {
  CREATE: 'Created',
  DUPLICATE: 'Created as a copy',
  SCHEDULE: 'Scheduled',
  RESCHEDULE: 'Rescheduled',
  UNSCHEDULE: 'Moved back to draft',
  SEND_NOW: 'Send confirmed',
  PROMOTE: 'Scheduled time reached',
  START: 'Sending started',
  PAUSE: 'Paused',
  RESUME: 'Resumed',
  CANCEL: 'Cancelled',
  FINISH: 'Finished',
  ADMIN_PAUSE: 'Paused by ETicketsGo',
};

/**
 * One campaign: where it is, what happened, and the controls that fit its status. While it is
 * starting or sending, the page refreshes every ten seconds.
 */
export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['campaigns-status', activeOrg.id],
    queryFn: () => api.campaigns.status(activeOrg.id),
  });
  const gate = campaignGate(status.data);
  const campaign = useQuery({
    queryKey: ['campaign', activeOrg.id, id],
    queryFn: () => api.campaigns.get(activeOrg.id, id),
    enabled: gate.kind === 'ready',
    refetchInterval: (q) => (q.state.data && LIVE.has(q.state.data.status) ? 10_000 : false),
  });
  const live = !!campaign.data && LIVE.has(campaign.data.status);
  const stats = useQuery({
    queryKey: ['campaign-stats', activeOrg.id, id],
    queryFn: () => api.campaigns.stats(activeOrg.id, id),
    enabled: gate.kind === 'ready' && !!status.data?.entitlements.analyticsBasic && !!campaign.data,
    refetchInterval: live ? 10_000 : false,
  });
  const history = useQuery({
    queryKey: ['campaign-history', activeOrg.id, id],
    queryFn: () => api.campaigns.history(activeOrg.id, id),
    enabled: gate.kind === 'ready',
    refetchInterval: live ? 10_000 : false,
  });

  if (status.isLoading || campaign.isLoading) return <Skeleton className="h-96 w-full" />;
  if (gate.kind !== 'ready') return <CampaignGateNotice gate={gate} />;
  if (campaign.isError || !campaign.data) {
    return (
      <ErrorState message="We could not open this campaign." onRetry={() => campaign.refetch()} />
    );
  }
  const c = campaign.data;

  async function act(name: string, run: (c: Campaign) => Promise<Campaign>, done: string) {
    setBusy(name);
    try {
      const next = await run(c);
      toast.push(done, 'success');
      if (name === 'duplicate') router.push(`/organizer/campaigns/${next.id}/edit`);
      else if (name === 'unschedule') router.push(`/organizer/campaigns/${c.id}/edit`);
      else await Promise.all([campaign.refetch(), history.refetch(), stats.refetch()]);
    } catch (err) {
      toast.push(errorMessage(err), 'error');
      await campaign.refetch();
    } finally {
      setBusy(null);
    }
  }

  const s = stats.data;
  const done = s ? s.targeted - s.pending : 0;
  const progress = s && s.targeted ? Math.round((done / s.targeted) * 100) : 0;
  const reason = c.status === 'PAUSED' ? pausedReasonText(c.pausedReason) : null;
  const org = activeOrg.id;

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.name}
        description={c.subject}
        breadcrumbs={[
          { label: 'Email campaigns', href: '/organizer/campaigns' },
          { label: c.name },
        ]}
        meta={<CampaignStatusChip status={c.status} />}
      />
      {reason && (
        <p className="rounded-md bg-tint-warning p-3 text-ui text-status-warning">{reason}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {c.status === 'DRAFT' && (
          <Link
            href={`/organizer/campaigns/${c.id}/edit`}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-action-primary px-5 text-ui font-semibold text-action-primary-foreground hover:bg-action-primary-hover"
          >
            Continue editing
          </Link>
        )}
        {c.status === 'SCHEDULED' && (
          <Button
            variant="outline"
            loading={busy === 'unschedule'}
            onClick={() =>
              act(
                'unschedule',
                (x) => api.campaigns.unschedule(org, x.id, x.version),
                'Moved back to draft.',
              )
            }
          >
            Edit (move back to draft)
          </Button>
        )}
        {LIVE.has(c.status) && (
          <Button
            variant="outline"
            loading={busy === 'pause'}
            onClick={() =>
              act('pause', (x) => api.campaigns.pause(org, x.id, x.version), 'Campaign paused.')
            }
          >
            Pause
          </Button>
        )}
        {c.status === 'PAUSED' && c.pausedReason !== 'ADMIN' && (
          <Button
            loading={busy === 'resume'}
            onClick={() =>
              act('resume', (x) => api.campaigns.resume(org, x.id, x.version), 'Campaign resumed.')
            }
          >
            Resume
          </Button>
        )}
        {['DRAFT', 'SCHEDULED', 'QUEUED', 'PAUSED'].includes(c.status) && (
          <Button
            variant="danger"
            loading={busy === 'cancel'}
            onClick={() =>
              act(
                'cancel',
                (x) => api.campaigns.cancel(org, x.id, x.version),
                'Campaign cancelled. Nothing more will be sent.',
              )
            }
          >
            Cancel campaign
          </Button>
        )}
        <Button
          variant="ghost"
          loading={busy === 'duplicate'}
          onClick={() =>
            act('duplicate', (x) => api.campaigns.duplicate(org, x.id), 'Copy created.')
          }
        >
          Duplicate
        </Button>
      </div>

      <Card title="Details">
        <dl className="grid gap-3 text-ui sm:grid-cols-3">
          <div>
            <dt className="text-text-secondary">Kind of email</dt>
            <dd className="text-text-primary">{PURPOSE_WORDS[c.purpose]?.label ?? c.purpose}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">
              {c.status === 'SCHEDULED' ? 'Scheduled for' : 'Started'}
            </dt>
            <dd className="text-text-primary">
              {c.status === 'SCHEDULED'
                ? dateTime(c.scheduledAt, undefined, c.timezone)
                : c.startedAt
                  ? dateTime(c.startedAt)
                  : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary">Finished</dt>
            <dd className="text-text-primary">{c.completedAt ? dateTime(c.completedAt) : '-'}</dd>
          </div>
        </dl>
      </Card>

      {!status.data?.entitlements.analyticsBasic ? (
        <Card title="Results">
          <p className="text-ui text-text-secondary">
            Campaign results are part of the Pro and Premium plans.
          </p>
        </Card>
      ) : stats.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : stats.isError || !s ? (
        <ErrorState message="We could not load the results." onRetry={() => stats.refetch()} />
      ) : (
        <Card title="Delivery">
          {s.targeted > 0 && (
            <div className="mb-4">
              <div className="flex justify-between text-caption text-text-secondary">
                <span>{live ? 'Sending' : 'Progress'}</span>
                <span>{progress}%</span>
              </div>
              <div
                className="mt-1 h-2 rounded-full bg-background-subtle"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-label="Delivery progress"
              >
                <div
                  className="h-2 rounded-full bg-action-primary"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
          <dl className="grid gap-3 sm:grid-cols-4" data-testid="campaign-stats">
            {[
              ['Matched', s.targeted],
              ['Skipped: not agreed', s.skippedConsent],
              ['Skipped: unsubscribed or not working', s.skippedSuppressed],
              ['Waiting to send', s.pending],
              ['Accepted by the email service', s.accepted],
              ['Delivered', s.delivered],
              ['Delayed (still trying)', s.deferred],
              ['Bounced', s.bounced],
              ['Marked as spam', s.complained],
              ['Failed', s.failed],
              ['Unsubscribed', s.unsubscribed],
              ['People who clicked', s.uniqueClicks],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg border border-border p-3">
                <dt className="text-caption text-text-secondary">{label}</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
                  {(value as number).toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-ui text-text-secondary">
            Click rate: {percent(s.clickRate)} of delivered emails. We do not track opens.
          </p>
          {s.failed > 0 && (
            <p className="mt-2 text-caption text-text-muted">
              Failed emails were tried up to 4 times. Emails the service refused were not retried.
              Failed emails use none of your plan.
            </p>
          )}
          <div className="mt-4">
            <h3 className="font-semibold text-text-primary">Attributed bookings</h3>
            {s.attributionLocked ? (
              <p className="mt-1 text-ui text-text-secondary">
                Sales results are part of the Premium plan.
              </p>
            ) : !s.attribution?.byCurrency.length ? (
              <p className="mt-1 text-ui text-text-secondary">
                No bookings attributed to this campaign yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 text-ui">
                {s.attribution.byCurrency.map((a) => (
                  <li key={a.currency}>
                    {a.orders} {a.orders === 1 ? 'booking' : 'bookings'},{' '}
                    {money(a.ticketRevenueMinor, a.currency)} in tickets
                    {a.revenuePerDeliveredMinor !== null && a.revenuePerDeliveredMinor !== undefined
                      ? ` (${money(a.revenuePerDeliveredMinor, a.currency)} per delivered email)`
                      : ''}
                  </li>
                ))}
              </ul>
            )}
            {s.attribution && (
              <p className="mt-1 text-caption text-text-muted">
                Attributed means the person clicked this email and booked with you within{' '}
                {s.attribution.windowDays} days. It does not mean the email caused the booking. Each
                booking counts for the last campaign clicked.
              </p>
            )}
          </div>
        </Card>
      )}

      <Card title="History">
        {history.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !history.data?.items.length ? (
          <p className="text-ui text-text-secondary">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border text-ui">
            {history.data.items.map((h) => {
              const action = (h.detail?.action as string | undefined) ?? h.type;
              const words =
                h.type === 'TEST_SENT'
                  ? 'Test email sent'
                  : h.type === 'PAUSED_BY_SYSTEM'
                    ? (pausedReasonText((h.detail?.reason as string) ?? '') ?? 'Paused')
                    : (HISTORY_WORDS[action] ?? action);
              return (
                <li key={h.id} className="flex justify-between gap-4 py-2">
                  <span className="text-text-primary">{words}</span>
                  <span className="text-text-muted">{dateTime(h.occurredAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
