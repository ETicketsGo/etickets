'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  DataTable,
  Dialog,
  Input,
  StatusBadge,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
  type PayoutAccount,
  useAuthUser,
} from '@eticketsgo/web-kit';
import { missingDutyNote, useHolds } from '../../../lib/capabilities';
import { independenceNote, queueOrder } from '../../../lib/bank-account-review';

const REVIEW_BADGE: Record<PayoutAccount['status'], { status: string; label: string }> = {
  PENDING_VERIFICATION: { status: 'UNDER_REVIEW', label: 'Waiting for verification' },
  VERIFIED: { status: 'APPROVED', label: 'Verified' },
  REJECTED: { status: 'REJECTED', label: 'Not accepted' },
};

const VERSION_BADGE = {
  PENDING_VERIFICATION: REVIEW_BADGE.PENDING_VERIFICATION,
  VERIFIED: REVIEW_BADGE.VERIFIED,
  REJECTED: REVIEW_BADGE.REJECTED,
  SUPERSEDED: { status: 'EXPIRED', label: 'Replaced before it was checked' },
} as const;

const FIELD_LABELS: Record<string, string> = {
  initial: 'New account',
  holderName: 'Account holder name',
  bankName: 'Bank name',
  bankCode: 'Bank code',
  accountNumber: 'Account number',
};

/** Every saved version of one account, masked, with who saved and who decided each. */
function HistoryList({ accountId }: { accountId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'payout-account-history', accountId],
    queryFn: () => api.admin.payoutAccountHistory(accountId),
  });
  if (isLoading) return null;
  return (
    <ul className="space-y-3">
      {(data ?? []).map((v) => (
        <li key={v.version} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text-primary">Version {v.version}</span>
            <StatusBadge {...VERSION_BADGE[v.status]} />
          </div>
          <p className="text-caption text-text-muted">
            {v.holderName} &middot; {v.bankName} &middot; {v.bankCode} &middot; ending{' '}
            {v.accountLast4}
          </p>
          <p className="text-caption text-text-muted">
            Saved {dateOnly(v.savedAt)} by {v.savedBy ?? 'unknown'}. Changed:{' '}
            {v.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ') || 'nothing'}.
          </p>
          {v.decidedAt ? (
            <p className="text-caption text-text-muted">
              Decided {dateOnly(v.decidedAt)} by {v.decidedBy ?? 'unknown'}
              {v.decisionNote ? `: ${v.decisionNote}` : ''}.
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The accounts the money is actually sent to.
 *
 * ── WHY THE NUMBER IS BEHIND A REVEAL ──────────────────────────────────────────────
 * Somebody here makes the transfers by hand, so the platform holds the account numbers. A
 * list that prints them is a list that gets screenshotted, shoulder-surfed and pasted into
 * chat. This shows the last four digits - enough to match a statement - and hands over the
 * full number only when somebody says why, which is written to the audit log with their name.
 *
 * The number is shown once, in this screen, and never re-fetched into a table.
 */
export function BankAccounts() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuthUser();
  const mayVerify = useHolds('BANK_VERIFY');
  const [revealing, setRevealing] = useState<PayoutAccount | null>(null);
  const [reason, setReason] = useState('');
  const [revealed, setRevealed] = useState<{ account: PayoutAccount; number: string } | null>(null);
  const [historyOf, setHistoryOf] = useState<PayoutAccount | null>(null);
  const [rejecting, setRejecting] = useState<PayoutAccount | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'payout-accounts'],
    queryFn: () => api.admin.payoutAccounts(),
  });

  const reveal = useMutation({
    mutationFn: () => api.admin.revealPayoutAccount(revealing!.id, reason),
    onSuccess: (account) => {
      setRevealed({ account, number: account.accountNumber });
      setRevealing(null);
      setReason('');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  // The version the reviewer is looking at travels with the request, so details the owner saved
  // a moment later are refused rather than verified by a look at the old ones.
  const verify = useMutation({
    mutationFn: (row: PayoutAccount) => api.admin.verifyPayoutAccount(row.id, row.version),
    onSuccess: () => {
      toast.push('Account marked as checked. The owners are told by email.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-accounts'] });
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-accounts'] });
    },
  });

  const reject = useMutation({
    mutationFn: () =>
      api.admin.rejectPayoutAccount(rejecting!.id, rejectReason, rejecting!.version),
    onSuccess: () => {
      toast.push('Details turned down. The owners are told why.', 'success');
      setRejecting(null);
      setRejectReason('');
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-accounts'] });
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-accounts'] });
    },
  });

  const columns: Column<PayoutAccount>[] = [
    { key: 'org', header: 'Organizer', render: (row) => row.organization?.name ?? '—' },
    { key: 'currency', header: 'Currency', render: (row) => row.currency },
    {
      key: 'account',
      header: 'Account',
      render: (row) => (
        <div>
          <p>{row.holderName}</p>
          <p className="text-caption text-text-muted">
            {row.bankName} &middot; {row.bankCode} &middot; ending {row.accountLast4} &middot;
            version {row.version}
          </p>
          <p className="text-caption text-text-muted">
            Entered by {row.savedBy?.email || 'unknown'}
          </p>
        </div>
      ),
    },
    {
      key: 'checked',
      header: 'Checked',
      render: (row) => (
        <div>
          <StatusBadge {...REVIEW_BADGE[row.status]} />
          {row.verifiedAt ? (
            <p className="mt-1 text-caption text-text-muted">{dateOnly(row.verifiedAt)}</p>
          ) : null}
          {/* The rule the server enforces, shown where the person will look for it. */}
          {row.verifiedAt && row.verifiedBy ? (
            <p className="mt-1 text-caption text-text-muted">
              Verified by {row.verifiedBy.email || 'unknown'}
              {row.verifiedBy.id === user?.id
                ? '. You verified this account, so someone else must mark payouts to it as paid.'
                : '. They cannot mark payouts to this account as paid; a different person must.'}
            </p>
          ) : null}
          {row.status === 'REJECTED' && row.rejectionReason ? (
            <p className="mt-1 text-caption text-text-muted">{row.rejectionReason}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'action',
      header: '',
      render: (row) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setRevealing(row)}>
            Show number
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOf(row)}>
            History
          </Button>
          {row.status === 'PENDING_VERIFICATION' && !mayVerify ? (
            <p className="max-w-xs text-right text-caption text-text-muted">
              {missingDutyNote('verify this account', 'BANK_VERIFY')}
            </p>
          ) : null}
          {row.status === 'PENDING_VERIFICATION' &&
          mayVerify &&
          independenceNote(row.independenceBlock) ? (
            <p className="max-w-xs text-right text-caption text-text-secondary">
              {independenceNote(row.independenceBlock)}
            </p>
          ) : null}
          {row.status === 'PENDING_VERIFICATION' && mayVerify && !row.independenceBlock ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => verify.mutate(row)}>
                Mark checked
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejecting(row)}>
                Turn down
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    // The dashboard's "bank accounts waiting" queue links here by this id.
    <section id="bank-accounts" className="scroll-mt-24">
      <Card title="Bank accounts">
        <p className="mb-3 text-sm text-text-secondary">
          Where each organizer is paid. Reading a full account number is recorded in the audit log
          with your name and your reason. Details are checked by someone other than the person who
          entered them: you cannot check an account you entered or one in your own organization.
          Every change starts a new version that waits here.
        </p>
        {isLoading ? null : data && data.length > 0 ? (
          <DataTable columns={columns} rows={queueOrder(data)} rowKey={(row) => row.id} />
        ) : (
          <p className="text-caption text-text-muted">
            No organizer has added an account yet. They add it in their own console, under Payouts.
          </p>
        )}

        <Dialog
          open={!!revealing}
          onClose={() => setRevealing(null)}
          title="Show the account number?"
          footer={
            <>
              <Button variant="outline" onClick={() => setRevealing(null)}>
                Cancel
              </Button>
              <Button
                loading={reveal.isPending}
                disabled={!reason.trim()}
                onClick={() => reveal.mutate()}
              >
                Show it
              </Button>
            </>
          }
        >
          {revealing && (
            <div className="space-y-3">
              <p>
                {revealing.organization?.name} &middot; {revealing.currency} &middot; ending{' '}
                {revealing.accountLast4}
              </p>
              <Input
                label="Why do you need it?"
                value={reason}
                maxLength={200}
                placeholder="Making the September settlement transfer"
                hint="Stored in the audit log with your name."
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}
        </Dialog>

        <Dialog
          open={!!historyOf}
          onClose={() => setHistoryOf(null)}
          title="Change history"
          footer={
            <Button variant="outline" onClick={() => setHistoryOf(null)}>
              Close
            </Button>
          }
        >
          {historyOf && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                {historyOf.organization?.name} &middot; {historyOf.currency}
              </p>
              <HistoryList accountId={historyOf.id} />
            </div>
          )}
        </Dialog>

        <Dialog
          open={!!rejecting}
          onClose={() => setRejecting(null)}
          title="Turn these details down?"
          footer={
            <>
              <Button variant="outline" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button
                loading={reject.isPending}
                disabled={!rejectReason.trim()}
                onClick={() => reject.mutate()}
              >
                Turn down
              </Button>
            </>
          }
        >
          {rejecting && (
            <div className="space-y-3">
              <p>
                {rejecting.organization?.name} &middot; {rejecting.currency} &middot; ending{' '}
                {rejecting.accountLast4}
              </p>
              <Input
                label="Why?"
                value={rejectReason}
                maxLength={200}
                placeholder="The account holder name does not match the legal name"
                hint="The owners are emailed this reason and it is stored. Do not type an account number."
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </div>
          )}
        </Dialog>

        <Dialog
          open={!!revealed}
          onClose={() => setRevealed(null)}
          title="Account number"
          footer={
            <Button variant="outline" onClick={() => setRevealed(null)}>
              Done
            </Button>
          }
        >
          {revealed && (
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">
                {revealed.account.holderName} &middot; {revealed.account.bankName} &middot;{' '}
                {revealed.account.bankCode}
              </p>
              <p className="select-all rounded-md border border-border bg-background-subtle px-3 py-2 font-mono text-lg">
                {revealed.number}
              </p>
              <p className="text-caption text-text-muted">
                This reveal is in the audit log. Close this when you have made the transfer.
              </p>
            </div>
          )}
        </Dialog>
      </Card>
    </section>
  );
}
