'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckCircle2, ExternalLink, Undo2, XCircle } from 'lucide-react';
import {
  api,
  Button,
  Card,
  DataTable,
  Dialog,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusBadge,
  money,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
  type OrganizationRefundRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const FILTERS = ['REQUESTED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED'] as const;

export default function RefundsPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<string>('REQUESTED');
  const [page, setPage] = useState(1);
  /** The refund awaiting confirmation, and which way. Money leaving needs a deliberate act. */
  const [pending, setPending] = useState<{
    row: OrganizationRefundRow;
    decision: 'APPROVE' | 'REJECT';
  } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['org-refunds', activeOrg.id, status, page],
    queryFn: () => api.organizations.refunds(activeOrg.id, { status, page, pageSize: 20 }),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVE' | 'REJECT' }) =>
      api.refunds.process(id, decision),
    onSuccess: (_r, vars) => {
      toast.push(
        vars.decision === 'APPROVE'
          ? 'Refund approved. The money is on its way back and a credit note has been issued.'
          : 'Refund declined.',
        'success',
      );
      qc.invalidateQueries({ queryKey: ['org-refunds', activeOrg.id] });
      qc.invalidateQueries({ queryKey: ['receipts', activeOrg.id] });
      setPending(null);
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      setPending(null);
    },
  });

  const columns: Column<OrganizationRefundRow>[] = [
    { key: 'requested', header: 'Requested', render: (r) => dateOnly(r.createdAt) },
    {
      key: 'customer',
      header: 'Customer',
      render: (r) => (
        <div>
          <div>{r.booking?.buyerName ?? r.booking?.buyerEmail ?? '—'}</div>
          <div className="text-caption text-text-muted">{r.booking?.reference ?? r.bookingId}</div>
        </div>
      ),
    },
    {
      key: 'event',
      header: 'Event',
      render: (r) => r.booking?.event?.title ?? '—',
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (r) => (
        <div className="tabular-nums">
          <div className="font-medium">{money(r.amountMinor, r.booking?.currency ?? 'INR')}</div>
          {r.booking && r.amountMinor < r.booking.totalMinor ? (
            <div className="text-caption text-text-muted">
              of {money(r.booking.totalMinor, r.booking.currency)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => <span className="text-caption">{r.reason}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'document',
      header: 'Credit note',
      render: (r) =>
        r.creditNote ? (
          <button
            type="button"
            onClick={() =>
              api.receipts
                .openHtml(r.creditNote!.id)
                .catch((e) => toast.push(errorMessage(e), 'error'))
            }
            className="inline-flex items-center gap-1 text-caption text-brand hover:underline"
          >
            {r.creditNote.number} <ExternalLink className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="text-caption text-text-muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.status === 'REQUESTED' ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setPending({ row: r, decision: 'APPROVE' })}>
              <CheckCircle2 className="mr-1 h-4 w-4" />
              Refund
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPending({ row: r, decision: 'REJECT' })}
            >
              <XCircle className="mr-1 h-4 w-4" />
              Decline
            </Button>
          </div>
        ) : null,
    },
  ];

  const totalPages = data ? Math.max(1, data.meta.totalPages) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refunds"
        description="Requests from your customers. Approving one sends the money back through the original payment method."
      />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => {
              setPage(1);
              setStatus(f);
            }}
            className={`rounded-full border px-3 py-1 text-caption transition ${
              status === f
                ? 'border-brand bg-brand/10 text-text-primary'
                : 'border-border text-text-secondary hover:border-brand/40'
            }`}
          >
            {f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {isError ? (
        <ErrorState
          message="We couldn't load refunds. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.data.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Undo2 className="h-8 w-8 text-text-muted" />
            <p className="text-text-primary">No {status.toLowerCase()} refunds.</p>
            <p className="max-w-md text-caption text-text-secondary">
              When a customer asks for their money back, the request appears here for you to approve
              or decline.
            </p>
          </div>
        </Card>
      ) : (
        <>
          <DataTable columns={columns} rows={data.data} rowKey={(r) => r.id} />
          {totalPages > 1 ? (
            <div className="flex items-center justify-between text-caption text-text-secondary">
              <span>
                Page {data.meta.page} of {totalPages} · {data.meta.total} requests
              </span>
              <div className="flex gap-2">
                <button
                  className="rounded-md border border-border px-3 py-1 disabled:opacity-40"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <button
                  className="rounded-md border border-border px-3 py-1 disabled:opacity-40"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {/*
        Refunding is irreversible and moves real money, so it is confirmed with the amount and
        the customer named — never a one-click action buried in a table row.
      */}
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.decision === 'APPROVE' ? 'Refund this booking?' : 'Decline this request?'}
      >
        {pending ? (
          <div className="space-y-4">
            {pending.decision === 'APPROVE' ? (
              <p className="text-body text-text-secondary">
                {money(pending.row.amountMinor, pending.row.booking?.currency ?? 'INR')} will be
                returned to{' '}
                <strong className="text-text-primary">
                  {pending.row.booking?.buyerName ??
                    pending.row.booking?.buyerEmail ??
                    'the customer'}
                </strong>{' '}
                through their original payment method. Their tickets are voided and a credit note is
                issued. This cannot be undone.
              </p>
            ) : (
              <p className="text-body text-text-secondary">
                The request is closed and no money moves. Your customer keeps their tickets.
              </p>
            )}
            <div className="rounded-md border border-border bg-surface-muted px-3 py-2 text-caption">
              <div className="text-text-muted">Their reason</div>
              <div className="text-text-primary">{pending.row.reason}</div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                loading={decide.isPending}
                onClick={() => decide.mutate({ id: pending.row.id, decision: pending.decision })}
              >
                {pending.decision === 'APPROVE' ? 'Refund now' : 'Decline request'}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
