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
  type LegalIdentitySnapshot,
} from '@eticketsgo/web-kit';

/**
 * A changed legal identity, waiting for an independent decision.
 *
 * Until it is approved the organizer's payouts are on hold: the API refuses to record a payout
 * paid or release a settlement. Their sales are not affected. The server refuses the decision
 * from whoever made the change or a member of the organization, and says so; this card shows
 * that refusal as it comes.
 */
const LABEL: Record<keyof LegalIdentitySnapshot, string> = {
  legalName: 'Legal name',
  legalEntityType: 'Legal form',
  registeredCountry: 'Country',
  taxRegistrationKind: 'Tax registration type',
  taxRegistrationNumber: 'Tax registration number',
};
const FIELDS = Object.keys(LABEL) as (keyof LegalIdentitySnapshot)[];

export function LegalIdentityReviewCard({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const { data } = useQuery({
    queryKey: ['org-legal-identity', organizationId],
    queryFn: () => api.admin.organizerLegalIdentity(organizationId),
  });
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REQUEST_CHANGES') =>
      api.admin.reviewOrganizerLegalIdentity(organizationId, {
        decision,
        note: note.trim() || undefined,
      }),
    onSuccess: async (r) => {
      toast.push(
        r.status === 'APPROVED'
          ? r.bankAccountsToReverify.length
            ? `Approved. ${r.bankAccountsToReverify.length} bank account(s) must now be verified again by another staff member.`
            : 'Approved. Payouts can resume.'
          : 'Changes requested. Payouts stay on hold.',
        'success',
      );
      setNote('');
      await qc.invalidateQueries({ queryKey: ['org-legal-identity', organizationId] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const review = data?.identityReview;
  if (!review || (review.status !== 'PENDING_REVIEW' && review.status !== 'CHANGES_REQUESTED')) {
    return null;
  }
  const changed = new Set(review.changedFields);
  const pending = review.status === 'PENDING_REVIEW';

  return (
    <div data-testid="legal-identity-review">
      <Card
        title="Legal details changed: payouts on hold"
        action={
          <Badge tone={pending ? 'warning' : 'error'}>
            {pending ? 'Waiting for review' : 'Changes requested'}
          </Badge>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            The organizer&apos;s payout-critical legal details differ from what was approved.
            Payouts stay on hold until someone other than the person who made the change approves
            them. Approving a new name or legal form sends their verified bank accounts back for
            verification.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption text-text-muted">
                  <th className="py-1 pr-3 font-medium">Field</th>
                  <th className="py-1 pr-3 font-medium">Approved</th>
                  <th className="py-1 font-medium">Now on file</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => (
                  <tr key={f} className={changed.has(f) ? 'bg-tint-warning' : undefined}>
                    <td className="py-1 pr-3 text-text-muted">{LABEL[f]}</td>
                    <td className="py-1 pr-3">{review.approved?.[f] ?? 'Not approved'}</td>
                    <td className="py-1 font-medium">{review.proposed[f] ?? '(blank)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {review.note ? <p className="text-caption text-text-muted">Note: {review.note}</p> : null}
          {pending ? (
            <>
              <Textarea
                id="identity-review-note"
                label="Note (optional, kept in the audit log)"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button loading={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
                  Approve new legal details
                </Button>
                <Button
                  variant="secondary"
                  loading={decide.isPending}
                  onClick={() => decide.mutate('REQUEST_CHANGES')}
                >
                  Request changes
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
