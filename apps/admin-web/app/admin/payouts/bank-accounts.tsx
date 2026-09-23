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
} from '@eticketsgo/web-kit';

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
  const [revealing, setRevealing] = useState<PayoutAccount | null>(null);
  const [reason, setReason] = useState('');
  const [revealed, setRevealed] = useState<{ account: PayoutAccount; number: string } | null>(null);

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

  const verify = useMutation({
    mutationFn: (id: string) => api.admin.verifyPayoutAccount(id),
    onSuccess: () => {
      toast.push('Account marked as checked.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-accounts'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
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
            {row.bankName} &middot; {row.bankCode} &middot; ending {row.accountLast4}
          </p>
        </div>
      ),
    },
    {
      key: 'checked',
      header: 'Checked',
      render: (row) =>
        row.verifiedAt ? (
          <span className="text-caption text-text-muted">{dateOnly(row.verifiedAt)}</span>
        ) : (
          <StatusBadge status="UNVERIFIED" />
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
          {!row.verifiedAt ? (
            <Button size="sm" variant="ghost" onClick={() => verify.mutate(row.id)}>
              Mark checked
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <Card title="Bank accounts">
      <p className="mb-3 text-sm text-text-secondary">
        Where each organizer is paid. Reading a full account number is recorded in the audit log
        with your name and your reason.
      </p>
      {isLoading ? null : data && data.length > 0 ? (
        <DataTable columns={columns} rows={data} rowKey={(row) => row.id} />
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
  );
}
