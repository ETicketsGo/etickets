'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Card,
  Button,
  Skeleton,
  StatusBadge,
  PageHeader,
  EmptyState,
  ErrorState,
  Dialog,
  ButtonLink,
  money,
  dateTime,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';

export default function RefundDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmApprove, setConfirmApprove] = useState(false);

  /*
    Read by id. This used to look for the refund inside the newest hundred rows of the list,
    so an older request — the kind most likely to need chasing — showed "not found".
  */
  const isNotFound = (e: unknown) => (e as { code?: string } | null)?.code === 'NOT_FOUND';
  const refundQ = useQuery({
    queryKey: ['admin', 'refunds', 'detail', id],
    queryFn: () => api.admin.refund(id),
    // A refund that does not exist will not start existing on a retry.
    retry: (count, e) => !isNotFound(e) && count < 2,
  });
  const refund = refundQ.data;

  const process = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => api.refunds.process(id, decision),
    onSuccess: (_r, decision) => {
      toast.push(`Refund ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`, 'success');
      setConfirmApprove(false);
      qc.invalidateQueries({ queryKey: ['admin', 'refunds'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (refundQ.isError && !isNotFound(refundQ.error))
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => refundQ.refetch()}
      />
    );
  if (refundQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!refund)
    return (
      <EmptyState
        title="Refund not found"
        hint="Check the link, or find it in the refunds list."
        action={<ButtonLink href="/admin/refunds">Back to refunds</ButtonLink>}
      />
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refund request"
        breadcrumbs={[{ label: 'Refunds', href: '/admin/refunds' }, { label: id.slice(0, 8) }]}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <StatusBadge status={refund.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Amount</dt>
              <dd className="font-semibold text-text-primary">
                {money(refund.amountMinor, refund.booking?.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Buyer</dt>
              <dd className="text-text-primary">{refund.booking?.buyerEmail ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Tickets</dt>
              <dd className="text-text-primary">{refund.ticketIds.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Requested</dt>
              <dd className="text-text-primary">{dateTime(refund.createdAt)}</dd>
            </div>
          </dl>
          <p className="mt-4 rounded-md bg-background-subtle p-3 text-sm text-text-secondary">
            {refund.reason}
          </p>
          <ButtonLink
            href={`/admin/bookings/${refund.bookingId}`}
            variant="outline"
            className="mt-4"
          >
            View booking
          </ButtonLink>
        </Card>

        <Card title="Decision">
          {refund.status === 'REQUESTED' ? (
            <div className="space-y-2">
              <Button
                className="w-full"
                loading={process.isPending && process.variables === 'APPROVE'}
                disabled={process.isPending}
                onClick={() => setConfirmApprove(true)}
              >
                Approve & refund
              </Button>
              <Button
                variant="danger"
                className="w-full"
                loading={process.isPending && process.variables === 'REJECT'}
                disabled={process.isPending}
                onClick={() => process.mutate('REJECT')}
              >
                Reject
              </Button>
            </div>
          ) : (
            <p className="text-sm text-text-muted">This refund is {refund.status.toLowerCase()}.</p>
          )}
        </Card>
      </div>

      <Dialog
        open={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        title="Approve this refund?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmApprove(false)}>
              Cancel
            </Button>
            <Button
              loading={process.isPending && process.variables === 'APPROVE'}
              onClick={() => process.mutate('APPROVE')}
            >
              Approve &amp; refund
            </Button>
          </>
        }
      >
        <p>
          This will refund <strong>{money(refund.amountMinor, refund.booking?.currency)}</strong> to{' '}
          {refund.booking?.buyerEmail ?? 'the buyer'}. This action cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}
