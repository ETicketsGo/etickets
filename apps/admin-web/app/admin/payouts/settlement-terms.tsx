'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  Card,
  DataTable,
  Dialog,
  Input,
  money,
  useToast,
  errorMessage,
  type Column,
  type PayoutSetting,
} from '@eticketsgo/web-kit';

/**
 * The terms settlements run under, editable here rather than in a deploy.
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────────────
 * The holding period and the minimum payout were environment variables: one number for
 * every organizer on the platform, changeable only by a release, with no record of who
 * changed it. They are commercial terms - a venue that sells out months ahead is not on the
 * terms a promoter with one show gets - so they belong in the product, with an audit trail.
 *
 * A row for the platform, and a row for each organizer who has been given different terms.
 * Empty means inherited: the platform row, then the deployment default.
 */
export function SettlementTerms({
  /** An organizer picked from the payouts list, to give their own terms. */
  openFor,
  onOpenHandled,
}: {
  openFor?: { organizationId: string; name: string } | null;
  onOpenHandled?: () => void;
} = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ organizationId: string | null; name: string } | null>(
    null,
  );
  const [holdDays, setHoldDays] = useState('');
  const [minimums, setMinimums] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'payout-settings'],
    queryFn: () => api.admin.payoutSettings(),
  });

  /*
    An organizer chosen in the payouts list below opens this editor on their row - existing
    terms if they have any, empty (inherited) if they do not. Handled here rather than in a
    second dialog, so there is one place terms are written from.
  */
  useEffect(() => {
    if (!openFor) return;
    const existing =
      data?.organizations.find((row) => row.organizationId === openFor.organizationId) ?? null;
    setHoldDays(existing?.holdDays == null ? '' : String(existing.holdDays));
    setMinimums(formatMinimums(existing?.minPayoutMinor ?? null));
    setEditing({ organizationId: openFor.organizationId, name: openFor.name });
    onOpenHandled?.();
  }, [openFor, data, onOpenHandled]);

  const save = useMutation({
    mutationFn: () =>
      api.admin.savePayoutSettings(editing?.organizationId ?? null, {
        // Blank means "inherit", which is not the same as zero: zero is a real term meaning
        // "payable as soon as the show is over".
        holdDays: holdDays.trim() === '' ? null : Number(holdDays),
        minPayoutMinor: parseMinimums(minimums),
      }),
    onSuccess: () => {
      toast.push('Settlement terms saved.', 'success');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-settings'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const open = (organizationId: string | null, name: string, row?: PayoutSetting | null) => {
    setHoldDays(row?.holdDays == null ? '' : String(row.holdDays));
    setMinimums(formatMinimums(row?.minPayoutMinor ?? null));
    setEditing({ organizationId, name });
  };

  const columns: Column<PayoutSetting>[] = [
    {
      key: 'org',
      header: 'Organizer',
      render: (row) => row.organization?.name ?? row.organizationId ?? 'Platform default',
    },
    {
      key: 'hold',
      header: 'Held for',
      render: (row) =>
        row.holdDays == null ? (
          <span className="text-text-muted">Inherited</span>
        ) : (
          `${row.holdDays} ${row.holdDays === 1 ? 'day' : 'days'} after the last show`
        ),
    },
    {
      key: 'minimum',
      header: 'Minimum payout',
      render: (row) =>
        row.minPayoutMinor && Object.keys(row.minPayoutMinor).length > 0 ? (
          Object.entries(row.minPayoutMinor)
            .map(([currency, amount]) => money(amount, currency))
            .join(', ')
        ) : (
          <span className="text-text-muted">Inherited</span>
        ),
    },
    {
      key: 'action',
      header: '',
      render: (row) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            open(row.organizationId, row.organization?.name ?? 'Platform default', row)
          }
        >
          Edit
        </Button>
      ),
    },
  ];

  const platformHold = data?.platform?.holdDays ?? data?.environmentHoldDays;

  return (
    <Card title="Settlement terms">
      <p className="mb-3 text-sm text-text-secondary">
        An event&rsquo;s revenue can be settled once the event has finished and its holding period
        has passed. Refunds from that event come off the settlement that covers it.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm text-text-secondary">
          Platform default:{' '}
          <strong>
            {isLoading ? '…' : `${platformHold} ${platformHold === 1 ? 'day' : 'days'}`}
          </strong>
          {!isLoading && !data?.platform ? (
            <span className="text-text-muted"> (from the deployment)</span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => open(null, 'Platform default', data?.platform ?? null)}
        >
          Change platform terms
        </Button>
      </div>

      {data && data.organizations.length > 0 ? (
        <DataTable columns={columns} rows={data.organizations} rowKey={(row) => row.id} />
      ) : (
        <p className="text-caption text-text-muted">
          No organizer is on different terms. Use &ldquo;Terms&rdquo; on a payout below to give one
          their own.
        </p>
      )}

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Settlement terms - ${editing?.name ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save terms
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            label="Hold for (days after the last show)"
            type="number"
            min={0}
            max={365}
            value={holdDays}
            placeholder={editing?.organizationId ? 'Inherit the platform default' : ''}
            hint="Leave empty to inherit. Zero means payable as soon as the event is over."
            onChange={(e) => setHoldDays(e.target.value)}
          />
          <Input
            label="Minimum payout"
            value={minimums}
            placeholder="INR 50000, USD 2500"
            hint="In minor units - paise, cents. Leave empty to inherit. A settlement below the minimum waits for the next one."
            onChange={(e) => setMinimums(e.target.value)}
          />
          <p className="text-caption text-text-muted">
            Every change is recorded in the audit log with the values before and after.
          </p>
        </div>
      </Dialog>
    </Card>
  );
}

/** "INR 50000, USD 2500" as the API takes it, or null for "inherit". */
function parseMinimums(raw: string): Record<string, number> | null {
  const text = raw.trim();
  if (!text) return null;
  const out: Record<string, number> = {};
  for (const part of text.split(',')) {
    const [currency, amount] = part.trim().split(/\s+/);
    if (!currency || !amount) continue;
    const value = Number(amount);
    if (!Number.isFinite(value)) continue;
    out[currency.toUpperCase()] = Math.round(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The stored map back as the text above. */
function formatMinimums(map: Record<string, number> | null): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([currency, amount]) => `${currency} ${amount}`)
    .join(', ');
}
