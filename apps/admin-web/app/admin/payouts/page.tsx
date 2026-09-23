'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Button,
  Dialog,
  Select,
  SearchInput,
  Pagination,
  EmptyState,
  PageHeader,
  money,
  dateOnly,
  useToast,
  errorMessage,
  Input,
  Textarea,
  type Column,
  type Payout,
} from '@eticketsgo/web-kit';
import { SettlementTerms } from './settlement-terms';
import { BankAccounts } from './bank-accounts';

const STATUSES = ['PENDING', 'SCHEDULED', 'PAID', 'FAILED'];
const PAGE_SIZE = 15;

export default function AdminPayouts() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Payout | null>(null);
  const [failing, setFailing] = useState<Payout | null>(null);
  /** An organizer whose own settlement terms an admin wants to set, picked from a payout row. */
  const [termsFor, setTermsFor] = useState<{ organizationId: string; name: string } | null>(null);
  /*
    The bank's own reference for the transfer. A payout marked paid with nothing to point at
    cannot be reconciled against a statement, which is the one thing anybody does with it
    afterwards.
  */
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [failureReason, setFailureReason] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'payouts'],
    queryFn: () => api.admin.payouts(),
  });

  const query = q.trim().toLowerCase();
  const filtered = (data ?? []).filter(
    (p) =>
      (!status || p.status === status) &&
      (!query || (p.organization?.name ?? '').toLowerCase().includes(query)),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const markPaid = useMutation({
    mutationFn: (payoutId: string) => api.admin.markPayoutPaid(payoutId, { reference, note }),
    onSuccess: () => {
      toast.push('Payout marked as paid.', 'success');
      setConfirm(null);
      setReference('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /*
    A returned transfer had no representation at all: the ledger said the organizer had been
    paid while the money sat back in the platform's account. A failed payout returns its
    revenue to the unsettled pool, so the next settlement picks it up by itself.
  */
  const markFailed = useMutation({
    mutationFn: (payoutId: string) => api.admin.markPayoutFailed(payoutId, failureReason),
    onSuccess: () => {
      toast.push(
        'Payout recorded as failed. Its revenue returns to the next settlement.',
        'success',
      );
      setFailing(null);
      setFailureReason('');
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<Payout>[] = [
    {
      key: 'org',
      header: 'Organizer',
      render: (p) => (
        <div>
          <p>{p.organization?.name ?? p.organizationId.slice(0, 8)}</p>
          <button
            type="button"
            className="text-caption text-action-primary hover:underline"
            onClick={() =>
              setTermsFor({
                organizationId: p.organizationId,
                name: p.organization?.name ?? p.organizationId.slice(0, 8),
              })
            }
          >
            Terms
          </button>
        </div>
      ),
    },
    /*
      Each payout in its own currency — they were all printed as rupees. Sorting by amount
      compares minor units across currencies, which only orders rows of the same currency
      meaningfully; the currency column sits beside it for that reason.
    */
    { key: 'currency', header: 'Currency', render: (p) => p.currency },
    {
      key: 'gross',
      header: 'Gross',
      render: (p) => money(p.grossMinor, p.currency),
      sortable: true,
      sortValue: (p) => p.grossMinor,
    },
    {
      key: 'net',
      header: 'Net',
      render: (p) => <span className="font-semibold">{money(p.netMinor, p.currency)}</span>,
      sortable: true,
      sortValue: (p) => p.netMinor,
    },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'created', header: 'Created', render: (p) => dateOnly(p.createdAt) },
    {
      key: 'action',
      header: '',
      /*
        Only an open payout can be marked paid — the API accepts PENDING and SCHEDULED and
        nothing else. Offering the button on a FAILED payout invited a click that could only
        ever come back as an error.
      */
      render: (p) =>
        p.status === 'PENDING' || p.status === 'SCHEDULED' ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(p)}>
              Mark paid
            </Button>
            <Button variant="ghost" onClick={() => setFailing(p)}>
              Failed
            </Button>
          </div>
        ) : p.status === 'PAID' ? (
          <div className="text-right">
            <p className="text-text-muted">{dateOnly(p.paidAt)}</p>
            {/* The reference is what reconciles this row to a bank statement. */}
            {p.paidReference ? (
              <p className="text-caption text-text-muted">{p.paidReference}</p>
            ) : null}
            <button
              type="button"
              className="text-caption text-action-primary hover:underline"
              onClick={() => setFailing(p)}
            >
              Returned by bank
            </button>
          </div>
        ) : p.status === 'FAILED' ? (
          <span className="text-caption text-status-error">{p.failureReason ?? 'Failed'}</span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Payouts" description="Organizer settlements across the platform." />

      <SettlementTerms openFor={termsFor} onOpenHandled={() => setTermsFor(null)} />

      <BankAccounts />
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search organizer…"
        />
        <Select
          aria-label="Status filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No payouts match these filters" />}
        rowKey={(p) => p.id}
      />
      {!isLoading && !isError && (
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      )}

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Mark payout as paid?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              loading={markPaid.isPending}
              onClick={() => confirm && markPaid.mutate(confirm.id)}
            >
              Confirm paid
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3">
            <p>
              Confirm settlement of <strong>{money(confirm.netMinor, confirm.currency)}</strong> to{' '}
              {confirm.organization?.name ?? 'this organizer'}.
            </p>
            <Input
              label="Bank reference"
              value={reference}
              maxLength={120}
              placeholder="UTR / wire reference"
              hint="What reconciles this payout to the bank statement. Recorded in the audit log."
              onChange={(e) => setReference(e.target.value)}
            />
            <Textarea
              label="Note (optional)"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!failing}
        onClose={() => setFailing(null)}
        title="Record a failed payout?"
        footer={
          <>
            <Button variant="outline" onClick={() => setFailing(null)}>
              Cancel
            </Button>
            <Button
              loading={markFailed.isPending}
              disabled={!failureReason.trim()}
              onClick={() => failing && markFailed.mutate(failing.id)}
            >
              Record failure
            </Button>
          </>
        }
      >
        {failing && (
          <div className="space-y-3">
            <p>
              {money(failing.netMinor, failing.currency)} to{' '}
              {failing.organization?.name ?? 'this organizer'} did not arrive. Its revenue goes back
              into the next settlement, so nothing is lost.
            </p>
            <Textarea
              label="What happened"
              rows={3}
              maxLength={500}
              value={failureReason}
              placeholder="Bank returned it: account closed"
              hint="Recorded on the payout and in the audit log."
              onChange={(e) => setFailureReason(e.target.value)}
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}
