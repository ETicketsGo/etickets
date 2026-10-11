'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  StatusBadge,
  dateOnly,
  useToast,
  errorMessage,
  MARKETS,
  type PayoutAccount,
  type PayoutAccountVersion,
} from '@eticketsgo/web-kit';

/**
 * Where this organizer's money is sent.
 *
 * ── WHY AN ORGANIZER TYPES THIS AT ALL ─────────────────────────────────────────────
 * Until Razorpay Route or Stripe Connect is switched on, a person at this end makes the
 * transfers. Without this screen the account arrives by email or over the phone, lives in
 * somebody's inbox, and is re-typed from a screenshot on payment day - which is how money
 * reaches the wrong account.
 *
 * The number is shown back only as its last four digits. Not secrecy theatre: the organizer
 * already knows their own number, printing it back adds a screen to read over a shoulder,
 * and it means an assistant with console access cannot collect account numbers.
 */
/** What each stage means to the owner, in the words they will act on. */
function reviewLine(account: PayoutAccount): string {
  if (account.status === 'VERIFIED') {
    return account.verifiedAt
      ? `Checked by ETicketsGo on ${dateOnly(account.verifiedAt)}.`
      : 'Checked by ETicketsGo.';
  }
  if (account.status === 'REJECTED') {
    return `ETicketsGo could not verify these details.${
      account.rejectionReason ? ` Reason: ${account.rejectionReason}.` : ''
    } Check them and save the account again.`;
  }
  return 'Waiting for ETicketsGo to check these details. You do not need to do anything.';
}

const REVIEW_BADGE: Record<PayoutAccount['status'], { status: string; label: string }> = {
  PENDING_VERIFICATION: { status: 'UNDER_REVIEW', label: 'Waiting for verification' },
  VERIFIED: { status: 'APPROVED', label: 'Verified' },
  REJECTED: { status: 'REJECTED', label: 'Not accepted' },
};

const FIELD_LABELS: Record<string, string> = {
  initial: 'New account',
  holderName: 'Account holder name',
  bankName: 'Bank name',
  bankCode: 'Bank code',
  accountNumber: 'Account number',
};

const VERSION_BADGE: Record<PayoutAccountVersion['status'], { status: string; label: string }> = {
  PENDING_VERIFICATION: { status: 'UNDER_REVIEW', label: 'Waiting for verification' },
  VERIFIED: { status: 'APPROVED', label: 'Verified' },
  REJECTED: { status: 'REJECTED', label: 'Not accepted' },
  SUPERSEDED: { status: 'EXPIRED', label: 'Replaced before it was checked' },
};

/**
 * Every version of the account that was saved, newest first.
 *
 * Masked on purpose: the last four digits, the bank and the holder, never the full number. The
 * point is "who changed what, and when", so an owner who sees a change they did not make knows to
 * act on it.
 */
function History({ orgId }: { orgId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['organizer', 'payout-account-history', orgId],
    queryFn: () => api.payouts.accountHistory(orgId),
  });
  if (isLoading || !data || data.length === 0) return null;
  return (
    <details className="mb-4 rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-text-primary">
        Change history ({data.length})
      </summary>
      <ul className="mt-2 space-y-2">
        {data.map((v) => {
          const badge = VERSION_BADGE[v.status];
          return (
            <li key={`${v.currency}-${v.version}`} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary">
                  {v.currency} version {v.version}
                </span>
                <StatusBadge status={badge.status} label={badge.label} />
              </div>
              <p className="text-caption text-text-muted">
                {v.holderName} &middot; {v.bankName} &middot; {v.bankCode} &middot; ending{' '}
                {v.accountLast4}
              </p>
              <p className="text-caption text-text-muted">
                Saved {dateOnly(v.savedAt)}
                {v.savedBy ? ` by ${v.savedBy}` : ''}. Changed:{' '}
                {v.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ') || 'nothing'}.
              </p>
              {v.decisionNote ? (
                <p className="text-caption text-text-muted">
                  Note from ETicketsGo: {v.decisionNote}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function BankAccount({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    currency: 'INR',
    holderName: '',
    bankName: '',
    bankCode: '',
    accountNumber: '',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['organizer', 'payout-accounts', orgId],
    queryFn: () => api.payouts.accounts(orgId),
  });

  const save = useMutation({
    mutationFn: () => api.payouts.saveAccount({ organizationId: orgId, ...form }),
    onSuccess: () => {
      toast.push(
        'Bank account saved. ETicketsGo will check it, and every owner is told by email.',
        'success',
      );
      setEditing(false);
      setForm({ ...form, accountNumber: '' });
      void qc.invalidateQueries({ queryKey: ['organizer', 'payout-accounts', orgId] });
      void qc.invalidateQueries({ queryKey: ['organizer', 'payout-account-history', orgId] });
      // The state card above reads the same account, so it must not keep saying "verified".
      void qc.invalidateQueries({ queryKey: ['organizer', 'payout-account-state', orgId] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const complete =
    form.holderName.trim().length > 1 &&
    form.bankName.trim().length > 1 &&
    form.bankCode.trim().length > 3 &&
    form.accountNumber.replace(/\D/g, '').length >= 6;

  return (
    <Card title="Bank account">
      <p className="mb-3 text-sm text-text-secondary">
        Where we send your settlements. We show only the last four digits afterwards, and every time
        somebody here reads the full number it is recorded.
      </p>

      {isLoading ? null : data && data.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {data.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            >
              <div>
                <p className="font-medium text-text-primary">
                  {account.holderName} &middot; {account.bankName}
                </p>
                <p className="text-caption text-text-muted">
                  {account.currency} &middot; {account.bankCode} &middot; ending{' '}
                  {account.accountLast4} &middot; version {account.version}
                </p>
                <p className="mt-1 text-caption text-text-secondary">{reviewLine(account)}</p>
              </div>
              {/*
                This badge says where THIS version of the details stands. It does not say whether
                sales are affected or when money moves: the Payout status card above answers that
                from the server's own state model, and a second reading of `verifiedAt` here would
                be the duplicate interpretation that model exists to prevent.
              */}
              <StatusBadge {...REVIEW_BADGE[account.status]} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-caption text-text-muted">
          No account on file. Your settlements cannot be paid until you add one.
        </p>
      )}

      <History orgId={orgId} />

      {editing ? (
        <div className="space-y-3">
          <p className="rounded-md border border-border bg-background-subtle px-3 py-2 text-caption text-text-secondary">
            Every change is saved as a new version and emailed to all owners of this organization.
            ETicketsGo staff check the new details before they count as verified. If you did not
            expect a change, contact support.
          </p>
          <Select
            label="Currency this account receives"
            value={form.currency}
            hint="An account per currency you sell in."
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          >
            {[...new Set(MARKETS.map((m) => m.currency))].map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
          <Input
            label="Account holder name"
            value={form.holderName}
            maxLength={140}
            hint="Exactly as your bank holds it."
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
          />
          <Input
            label="Bank name"
            value={form.bankName}
            maxLength={140}
            onChange={(e) => setForm({ ...form, bankName: e.target.value })}
          />
          <Input
            label="IFSC, routing number or SWIFT"
            value={form.bankCode}
            maxLength={34}
            onChange={(e) => setForm({ ...form, bankCode: e.target.value })}
          />
          <Input
            label="Account number"
            value={form.accountNumber}
            maxLength={34}
            inputMode="numeric"
            autoComplete="off"
            hint="Stored encrypted. Check it twice - a wrong digit sends your money to somebody else."
            onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
          />
          <div className="flex gap-2">
            <Button loading={save.isPending} disabled={!complete} onClick={() => save.mutate()}>
              Save account
            </Button>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {data && data.length > 0 ? 'Add or replace an account' : 'Add a bank account'}
        </Button>
      )}
    </Card>
  );
}
