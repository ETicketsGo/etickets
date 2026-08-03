'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  Input,
  PageHeader,
  Select,
  DataTable,
  money,
  useToast,
  type Column,
  type FeeRule,
} from '@eticketsgo/web-kit';

/** Currencies the platform seeds bands for. Editing never changes a rule's currency. */
const CURRENCY_LABELS: Record<string, string> = {
  INR: 'India (INR)',
  USD: 'United States (USD)',
  CAD: 'Canada (CAD)',
  AUD: 'Australia (AUD)',
};

/** Draft state for the edit dialog. Kept as strings so a half-typed value does not fight the input. */
interface Draft {
  label: string;
  minMinor: string;
  maxMinor: string;
  feeMinor: string;
  active: boolean;
}

const toDraft = (r: FeeRule): Draft => ({
  label: r.label,
  minMinor: String(r.minMinor),
  maxMinor: r.maxMinor === null ? '' : String(r.maxMinor),
  feeMinor: String(r.feeMinor),
  active: r.active,
});

export default function AdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<FeeRule | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'fee-rules'],
    queryFn: () => api.admin.feeRules(),
  });

  const save = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof api.admin.updateFeeRule>[1];
    }) => api.admin.updateFeeRule(id, patch),
    onSuccess: () => {
      toast.push('Fee rule updated.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-rules'] });
      setEditing(null);
      setDraft(null);
    },
    // The API rejects inverted and overlapping bands; surface its reason rather than a generic
    // failure, because "why was this refused" is the whole value of those checks.
    onError: (err: unknown) =>
      toast.push(err instanceof Error ? err.message : 'Could not update the fee rule.', 'error'),
  });

  const openEditor = (rule: FeeRule) => {
    setEditing(rule);
    setDraft(toDraft(rule));
  };

  const submit = () => {
    if (!editing || !draft) return;
    const trimmedMax = draft.maxMinor.trim();
    save.mutate({
      id: editing.id,
      patch: {
        label: draft.label.trim(),
        minMinor: Number(draft.minMinor),
        // Empty means "and above" — a real value, distinct from leaving the field alone.
        maxMinor: trimmedMax === '' ? null : Number(trimmedMax),
        feeMinor: Number(draft.feeMinor),
        active: draft.active,
      },
    });
  };

  /** Numeric fields are minor units; block a submit that would send NaN to a money endpoint. */
  const invalid =
    !draft ||
    draft.label.trim() === '' ||
    !Number.isInteger(Number(draft.minMinor)) ||
    !Number.isInteger(Number(draft.feeMinor)) ||
    (draft.maxMinor.trim() !== '' && !Number.isInteger(Number(draft.maxMinor)));

  const columns = (currency: string): Column<FeeRule>[] => [
    { key: 'label', header: 'Band', render: (r) => r.label },
    { key: 'min', header: 'From', render: (r) => money(r.minMinor, currency) },
    {
      key: 'max',
      header: 'To',
      render: (r) => (r.maxMinor == null ? 'and above' : money(r.maxMinor, currency)),
    },
    { key: 'fee', header: 'Booking fee', render: (r) => money(r.feeMinor, currency) },
    { key: 'active', header: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => openEditor(r)}>
          Edit
        </Button>
      ),
    },
  ];

  // Group by currency: bands only make sense compared against others in the same currency,
  // and fees are resolved per currency at booking time.
  const byCurrency = (data ?? []).reduce<Record<string, FeeRule[]>>((acc, rule) => {
    (acc[rule.currency] ??= []).push(rule);
    return acc;
  }, {});
  const currencies = Object.keys(byCurrency).sort();

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Platform fee configuration." />

      {isLoading && <Card title="Booking fee rules">Loading…</Card>}

      {!isLoading &&
        currencies.map((currency) => (
          <Card
            key={currency}
            title={`Booking fee rules — ${CURRENCY_LABELS[currency] ?? currency}`}
          >
            <DataTable
              columns={columns(currency)}
              rows={byCurrency[currency]}
              rowKey={(r) => r.id}
            />
          </Card>
        ))}

      {!isLoading && currencies.length === 0 && (
        <Card title="Booking fee rules">
          <p className="text-sm text-text-secondary">
            No fee rules configured. The booking engine falls back to the built-in India defaults
            until rules exist.
          </p>
        </Card>
      )}

      <Card title="How booking fees resolve">
        <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">
          <li>
            Fees are matched per <strong>currency</strong>, then by the first band whose range
            contains the order subtotal.
          </li>
          <li>
            All amounts are <strong>minor units</strong> — paise for INR, cents for USD/CAD/AUD.
            Enter 500 for ₹5 or $5.00.
          </li>
          <li>
            Bands within a currency must not overlap while active. The API refuses an overlapping
            edit, because first-match resolution would make the fee depend on row order.
          </li>
          <li>Leave the upper bound empty for the top band (&ldquo;and above&rdquo;).</li>
          <li>Every change is recorded in the audit log with its before and after values.</li>
        </ul>
      </Card>

      <Dialog
        open={!!editing}
        onClose={() => {
          setEditing(null);
          setDraft(null);
        }}
        title={editing ? `Edit fee rule — ${editing.currency}` : 'Edit fee rule'}
      >
        {draft && editing && (
          <div className="space-y-3">
            <Input
              label="Label"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <Input
              label={`From (minor units, ${editing.currency})`}
              inputMode="numeric"
              value={draft.minMinor}
              onChange={(e) => setDraft({ ...draft, minMinor: e.target.value })}
            />
            <Input
              label={`To (minor units — leave empty for "and above")`}
              inputMode="numeric"
              value={draft.maxMinor}
              onChange={(e) => setDraft({ ...draft, maxMinor: e.target.value })}
            />
            <Input
              label={`Booking fee (minor units, ${editing.currency})`}
              inputMode="numeric"
              value={draft.feeMinor}
              onChange={(e) => setDraft({ ...draft, feeMinor: e.target.value })}
            />
            <Select
              label="Active"
              value={draft.active ? 'yes' : 'no'}
              onChange={(e) => setDraft({ ...draft, active: e.target.value === 'yes' })}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>

            <p className="text-xs text-text-muted">
              Preview: {money(Number(draft.minMinor) || 0, editing.currency)} –{' '}
              {draft.maxMinor.trim() === ''
                ? 'and above'
                : money(Number(draft.maxMinor) || 0, editing.currency)}{' '}
              → fee {money(Number(draft.feeMinor) || 0, editing.currency)}
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setDraft(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={submit} disabled={invalid || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
