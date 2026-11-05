'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  dateTime,
  errorMessage,
  useToast,
  type AdminCampaignRow,
  type CampaignStatus,
} from '@eticketsgo/web-kit';
import { useHolds } from '../../../lib/capabilities';

const STATUSES: (CampaignStatus | '')[] = [
  '',
  'SCHEDULED',
  'QUEUED',
  'SENDING',
  'PAUSED',
  'COMPLETED',
  'PARTIALLY_FAILED',
  'FAILED',
  'CANCELLED',
  'DRAFT',
];

function pct(v: number | null): string {
  return v === null ? '-' : `${(v * 100).toFixed(2)}%`;
}

/**
 * Organizer email campaigns across the platform: what is going out under our name, the bounce
 * and complaint rates mailbox providers judge us by, and a brake.
 *
 * Read-only for ORGANIZER_READ. Pausing (and lifting a staff pause) needs ORGANIZER_REVIEW and
 * a fresh second factor, and is audited. No recipient or address is ever shown: the API does not
 * return one.
 */
export default function AdminCampaignsPage() {
  const toast = useToast();
  const canPause = useHolds('ORGANIZER_REVIEW');
  const [status, setStatus] = useState<CampaignStatus | ''>('');
  const [pausing, setPausing] = useState<AdminCampaignRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const health = useQuery({
    queryKey: ['admin', 'campaigns', 'health'],
    queryFn: () => api.admin.campaigns.health(),
  });
  const list = useQuery({
    queryKey: ['admin', 'campaigns', status],
    queryFn: () => api.admin.campaigns.list(status ? { status } : {}),
  });

  async function release(row: AdminCampaignRow) {
    try {
      await api.admin.campaigns.release(row.id);
      toast.push('Pause lifted.', 'success');
      await list.refetch();
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email campaigns"
        description="Organizer campaigns sent under the ETicketsGo name. No recipients are shown."
      />

      <Card title="Sending health">
        {health.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : health.isError || !health.data ? (
          <ErrorState
            message="We could not load sending health."
            onRetry={() => health.refetch()}
          />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {health.data.windows.map((w) => {
                const bounceHigh = (w.bounceRate ?? 0) >= health.data.thresholds.bounceRate;
                const complaintHigh =
                  (w.complaintRate ?? 0) >= health.data.thresholds.complaintRate;
                return (
                  <div key={w.days} className="rounded-lg border border-border p-4">
                    <p className="text-caption text-text-secondary">Last {w.days} days</p>
                    <p className="mt-1 text-ui text-text-primary">
                      {w.accepted.toLocaleString()} emails accepted
                    </p>
                    <p
                      className={`text-ui ${bounceHigh ? 'text-status-error' : 'text-text-primary'}`}
                    >
                      Bounce rate {pct(w.bounceRate)} ({w.bounced.toLocaleString()})
                    </p>
                    <p
                      className={`text-ui ${complaintHigh ? 'text-status-error' : 'text-text-primary'}`}
                    >
                      Complaint rate {pct(w.complaintRate)} ({w.complained.toLocaleString()})
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-caption text-text-muted">
              Amazon SES reviews an account at about {pct(health.data.thresholds.bounceRate)}{' '}
              bounces and {pct(health.data.thresholds.complaintRate)} complaints.{' '}
              {health.data.campaignsInFlight} campaigns are starting or sending now.
            </p>
          </div>
        )}
      </Card>

      <Card
        title="Campaigns"
        action={
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as CampaignStatus | '')}
          >
            {STATUSES.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? s.replace(/_/g, ' ').toLowerCase() : 'all'}
              </option>
            ))}
          </Select>
        }
        padding="none"
      >
        {list.isLoading ? (
          <Skeleton className="m-4 h-48" />
        ) : list.isError || !list.data ? (
          <ErrorState message="We could not load campaigns." onRetry={() => list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <p className="p-6 text-ui text-text-secondary">No campaigns.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-ui">
              <thead className="text-caption text-text-secondary">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Organizer
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Campaign
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Started
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Bounced / complained
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.data.items.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 text-text-primary">
                      {c.organizationName ?? c.organizationId}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{c.name}</p>
                      <p className="text-caption text-text-muted">{c.subject}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        tone={
                          c.status === 'FAILED'
                            ? 'error'
                            : c.status === 'PAUSED'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {c.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      {c.pausedReason === 'ADMIN' && (
                        <p className="mt-1 text-caption text-status-warning">Paused by staff</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {c.startedAt ? dateTime(c.startedAt) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {(c.counters?.BOUNCED ?? 0).toLocaleString()} /{' '}
                      {(c.counters?.COMPLAINED ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canPause && ['SCHEDULED', 'QUEUED', 'SENDING'].includes(c.status) && (
                        <Button variant="outline" size="sm" onClick={() => setPausing(c)}>
                          Pause
                        </Button>
                      )}
                      {canPause && c.pausedReason === 'ADMIN' && (
                        <Button variant="ghost" size="sm" onClick={() => void release(c)}>
                          Lift pause
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog
        open={!!pausing}
        onClose={() => setPausing(null)}
        title="Pause this campaign"
        description="Nothing more is sent until staff lift the pause. The organizer cannot resume it. This is audited."
        footer={
          <>
            <Button variant="outline" onClick={() => setPausing(null)}>
              Keep sending
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={async () => {
                if (!pausing) return;
                setBusy(true);
                try {
                  await api.admin.campaigns.pause(pausing.id, reason.trim());
                  toast.push('Campaign paused.', 'success');
                  setPausing(null);
                  setReason('');
                  await list.refetch();
                } catch (err) {
                  toast.push(errorMessage(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Pause campaign
            </Button>
          </>
        }
      >
        <Textarea
          label="Why (kept in the audit log)"
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    </div>
  );
}
