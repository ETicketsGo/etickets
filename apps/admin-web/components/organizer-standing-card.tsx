'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  Textarea,
  Badge,
  Skeleton,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';

/**
 * What this organizer still owes us, and the two things an admin can do about them.
 *
 * ── WHY SUSPEND SITS BESIDE DELETE ─────────────────────────────────────────────────
 * Asked for: a way to delete an organizer. Most of the ones somebody wants gone cannot be
 * deleted and should not be - they have taken money and issued tickets, and those records
 * are what answer a chargeback months later. So the card offers both, and the delete refusal
 * names what is in the way rather than greying a button out with no explanation.
 *
 * Suspension is the answer in almost every real case, and it now means something: a
 * suspended organizer's checkout is refused. It was a status nothing wrote and nothing read
 * until this was built.
 */
const SEVERITY_TONE = {
  // `error`, not `danger`: there is no danger tone, and asking for one rendered no badge at all.
  BLOCKING: 'error',
  IMPORTANT: 'warning',
  SUGGESTED: 'neutral',
} as const;

export function OrganizerStandingCard({
  organizationId,
  name,
  status,
}: {
  organizationId: string;
  name: string;
  status: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  const readiness = useQuery({
    queryKey: ['admin', 'organizer-readiness', organizationId],
    queryFn: () => api.admin.organizerReadiness(organizationId),
  });

  /*
    How many complaints are open against them.

    Read here because this card is where somebody decides whether this organizer keeps selling,
    and that decision cannot be made without it. A complaint is recorded against the seller who
    took the money - derived from the booking, never stated by the person complaining.
  */
  const complaints = useQuery({
    queryKey: ['admin', 'organizer-complaints', organizationId],
    queryFn: () => api.admin.complaintCounts(organizationId),
  });

  // Asked before the dialog opens, so the button can say what will happen rather than
  // discovering it after somebody has pressed Delete.
  const blockers = useQuery({
    queryKey: ['admin', 'organizer-blockers', organizationId],
    queryFn: () => api.admin.organizerDeletionBlockers(organizationId),
  });

  const suspend = useMutation({
    mutationFn: (suspended: boolean) =>
      api.admin.setOrganizerSuspension(organizationId, suspended, reason),
    onSuccess: (_result, suspended) => {
      toast.push(
        suspended
          ? 'Suspended. Their checkout is refused from now on.'
          : 'Reinstated. They can sell again.',
      );
      setSuspending(false);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast.push(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => api.admin.deleteOrganizer(organizationId),
    onSuccess: () => {
      toast.push(`${name} deleted.`);
      // Nothing left to show on this page.
      window.location.href = '/admin/organizers';
    },
    onError: (e) => {
      setDeleting(false);
      toast.push(errorMessage(e));
    },
  });

  const suspended = status === 'SUSPENDED';
  const items = readiness.data?.items ?? [];

  const openComplaints = complaints.data?.open ?? 0;

  return (
    <Card title="Standing and outstanding information">
      {complaints.data && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background-subtle/50 p-3">
          <Badge tone={openComplaints > 0 ? 'error' : 'neutral'}>
            {openComplaints} open complaint{openComplaints === 1 ? '' : 's'}
          </Badge>
          <p className="text-caption text-text-muted">
            {complaints.data.total} in total from customers who bought from them.
          </p>
          {complaints.data.total > 0 && (
            <Link
              href={`/admin/support?organizationId=${organizationId}&kind=COMPLAINT`}
              className="text-caption text-action-primary underline-offset-4 hover:underline"
            >
              Read them
            </Link>
          )}
        </div>
      )}
      {readiness.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : items.length === 0 ? (
        <p className="mb-4 text-sm text-text-secondary">
          Nothing outstanding. This organizer has given us everything we ask for.
        </p>
      ) : (
        <ul className="mb-4 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-start gap-2">
              <Badge tone={SEVERITY_TONE[item.severity]}>{item.severity.toLowerCase()}</Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary">{item.title}</p>
                <p className="text-caption text-text-muted">{item.consequence}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {suspended ? (
          <Button
            variant="secondary"
            loading={suspend.isPending}
            onClick={() => suspend.mutate(false)}
          >
            Reinstate
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setSuspending(true)}>
            Suspend
          </Button>
        )}
        <Button variant="ghost" onClick={() => setDeleting(true)}>
          Delete
        </Button>
        <p className="text-caption text-text-muted">
          {suspended
            ? 'Suspended: their checkout is refused. Reinstating takes effect immediately.'
            : 'Suspending stops their sales at once and can be undone.'}
        </p>
      </div>

      <Dialog
        open={suspending}
        onClose={() => setSuspending(false)}
        title={`Suspend ${name}?`}
        footer={
          <>
            <Button variant="outline" onClick={() => setSuspending(false)}>
              Cancel
            </Button>
            <Button
              loading={suspend.isPending}
              disabled={!reason.trim()}
              onClick={() => suspend.mutate(true)}
            >
              Suspend them
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Their checkout is refused from the moment you confirm. Tickets already sold stay valid,
            and nothing they have set up is lost.
          </p>
          <Textarea
            label="Why are you suspending them?"
            rows={3}
            maxLength={500}
            value={reason}
            placeholder="Unanswered compliance request of 18 September"
            hint="Recorded in the audit log. Support reads this when the organizer asks."
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Dialog>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${name}?`}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              loading={remove.isPending}
              disabled={!blockers.data?.deletable}
              onClick={() => remove.mutate()}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        {blockers.data?.deletable ? (
          <p className="text-sm text-text-secondary">
            This organizer has never traded, so nothing is lost but their own setup: events, venues
            and team. This cannot be undone.
          </p>
        ) : (
          <div className="space-y-2 text-sm text-text-secondary">
            <p>
              This organizer has <strong>{blockers.data?.blockers.join(', ')}</strong>. Those
              records answer a refund, a chargeback or a tax question long after somebody stops
              selling, so they are not ours to throw away.
            </p>
            <p>Suspend them instead - it stops their sales at once and can be undone.</p>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
