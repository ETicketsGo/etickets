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
  useToast,
  errorMessage,
  MARKETS,
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
      toast.push('Bank account saved. We will use it for your next payout.', 'success');
      setEditing(false);
      setForm({ ...form, accountNumber: '' });
      void qc.invalidateQueries({ queryKey: ['organizer', 'payout-accounts', orgId] });
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
                  {account.accountLast4}
                </p>
              </div>
              {/* Verified means somebody here checked it against a document or a test transfer. */}
              <StatusBadge status={account.verifiedAt ? 'VERIFIED' : 'UNVERIFIED'} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-caption text-text-muted">
          No account on file. Your settlements cannot be paid until you add one.
        </p>
      )}

      {editing ? (
        <div className="space-y-3">
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
