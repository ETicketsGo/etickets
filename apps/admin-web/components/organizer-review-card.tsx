'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  Textarea,
  useToast,
  errorMessage,
  dateOnly,
  type Organization,
} from '@eticketsgo/web-kit';
import { CountryLabel } from './country-filter';
import { statusWords } from '../lib/words';

/**
 * Approve or reject an organizer, with what the decision rests on in front of the reviewer.
 *
 * ── WHAT WAS WRONG WITH IT ─────────────────────────────────────────────────────────
 * Walked on QA (2026-10-15) as a reviewer approving a brand-new organizer:
 *
 *  - The card was a note box and two buttons. Who the organizer says they are (legal name, what
 *    they registered as, where) sat a screen further down inside an edit form, and the API's
 *    review signals - how old the owner's account is, other organizations the same person
 *    registered, look-alike names already on the platform - were never shown anywhere.
 *  - Reject went through with an empty note. The organizer is emailed the note as the reason,
 *    so an empty one tells them "no" and nothing they can fix.
 *  - The API refuses an approval with no declared identity and offers an override on the
 *    record. The console had no way to give that reason, so the refusal was a dead end.
 *  - After a decision the card said "This organizer is approved." and nothing about it.
 */
export function OrganizerReviewCard({ org }: { org: Organization }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const pending = org.status === 'PENDING';

  const signals = useQuery({
    queryKey: ['admin', 'organizer-review-signals', org.id],
    queryFn: () => api.admin.organizerReviewSignals(org.id),
    enabled: pending,
  });
  const missing = signals.data?.identity.missing ?? [];

  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.admin.reviewOrganizer(
        org.id,
        decision,
        note.trim() || undefined,
        decision === 'APPROVE' && missing.length > 0 ? override.trim() : undefined,
      ),
    onSuccess: (_res, decision) => {
      toast.push(
        decision === 'APPROVE'
          ? `${org.name} is approved. They have been told and can now put events up for review.`
          : `${org.name} is rejected. They have been sent your reason.`,
        'success',
      );
      setRejecting(false);
      qc.invalidateQueries({ queryKey: ['org', org.id] });
      /*
        The organizers list and the dashboard's counts show this status too. Refreshing only
        this page left the organizer listed as pending on the screen the reviewer goes back to.
      */
      qc.invalidateQueries({ queryKey: ['admin', 'organizers'] });
      qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (!pending) {
    return (
      <Card title="Review">
        <p className="text-sm text-text-secondary">
          {org.status === 'APPROVED'
            ? 'Approved. They can sell once each event is approved.'
            : org.status === 'SUSPENDED'
              ? 'Suspended. Their checkout is refused until somebody reinstates them below.'
              : org.status === 'REJECTED'
                ? 'Rejected. They cannot sell.'
                : `${statusWords(org.status)}.`}
        </p>
        <p className="mt-2 text-caption text-text-muted">
          Who decided, and why, is in the audit log for this organizer.
        </p>
      </Card>
    );
  }

  const ageDays = signals.data?.owner?.accountAgeDays;
  const others = signals.data?.otherOrganizationsByOwner ?? [];
  const lookAlikes = signals.data?.nameCollisions ?? [];
  const overrideReady = missing.length === 0 || override.trim().length >= 10;

  return (
    <Card title="Review">
      <div className="space-y-4">
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">Who they say they are</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-text-muted">Legal name</dt>
            <dd className="text-text-primary">{org.legalName || 'Not given'}</dd>
            <dt className="text-text-muted">Registered as</dt>
            <dd className="text-text-primary">{org.legalEntityType || 'Not given'}</dd>
            <dt className="text-text-muted">Country</dt>
            <dd className="text-text-primary">
              {org.registeredCountry ? (
                <CountryLabel stored={org.registeredCountry} />
              ) : (
                'Not given'
              )}
            </dd>
          </dl>
          {missing.length > 0 ? (
            <p className="text-caption text-status-warning">
              Missing: {missing.join(', ')}. Approval needs these. Ask them to add them under
              Settings, or approve below with a written reason.
            </p>
          ) : signals.data ? (
            <p className="text-caption text-text-muted">
              Approval needs these three, and they are all given. A tax number is not needed.
            </p>
          ) : null}
        </div>

        {signals.data && (
          <ul className="space-y-1 text-caption text-text-secondary">
            {ageDays !== undefined && (
              <li>
                Owner account made{' '}
                {ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`}
                {signals.data.owner?.emailDomain
                  ? `, email at ${signals.data.owner.emailDomain}`
                  : ''}
                .
              </li>
            )}
            {others.length > 0 ? (
              <li>
                <Badge tone="warning">Same owner</Badge>{' '}
                {others.map((o) => `${o.name} (${statusWords(o.status).toLowerCase()})`).join(', ')}
              </li>
            ) : (
              <li>The owner has no other organization here.</li>
            )}
            {lookAlikes.length > 0 ? (
              <li>
                <Badge tone="warning">Similar name</Badge>{' '}
                {lookAlikes
                  .map((o) => `${o.name} (${statusWords(o.status).toLowerCase()})`)
                  .join(', ')}
              </li>
            ) : (
              <li>No other organization has a name like this.</li>
            )}
          </ul>
        )}

        <Textarea
          id="note"
          label={rejecting ? 'Why are you rejecting them?' : 'Note (optional)'}
          hint={
            rejecting
              ? 'Sent to the organizer as the reason. Say what they would need to change.'
              : 'Sent to the organizer with the decision.'
          }
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {missing.length > 0 && !rejecting && (
          <Textarea
            id="override"
            label="Reason to approve without these"
            hint="At least 10 characters. Recorded in the audit log with your name."
            rows={2}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
          />
        )}

        {rejecting ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={review.isPending}
              disabled={review.isPending || note.trim().length === 0}
              onClick={() => review.mutate('REJECT')}
            >
              Reject and send reason
            </Button>
            <Button variant="outline" onClick={() => setRejecting(false)}>
              Back
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              loading={review.isPending && review.variables === 'APPROVE'}
              disabled={review.isPending || !overrideReady}
              onClick={() => review.mutate('APPROVE')}
            >
              Approve
            </Button>
            <Button variant="danger" disabled={review.isPending} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        )}
        <p className="text-caption text-text-muted">
          Registered {dateOnly(org.createdAt)}. Approving lets them submit events; each event is
          still reviewed before it sells, unless you turn that off below.
        </p>
      </div>
    </Card>
  );
}
