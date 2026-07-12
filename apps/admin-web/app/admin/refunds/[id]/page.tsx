'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  api,
  Card,
  Button,
  Skeleton,
  StatusBadge,
  PageHeader,
  EmptyState,
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

  // No get-by-id endpoint; locate the refund within the admin list.
  const listQ = useQuery({
    queryKey: ['admin', 'refunds', 'all'],
    queryFn: () => api.admin.refunds({ page: 1, pageSize: 100 }),
  });
  const refund = listQ.data?.data.find((r) => r.id === id);

  const process = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => api.refunds.process(id, decision),
    onSuccess: (_r, decision) => {
      toast.push(`Refund ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`, 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'refunds'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (listQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!refund)
    return (
      <EmptyState
        title="Refund not found"
        hint="It may be on another page."
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
              <dd className="font-semibold text-text-primary">{money(refund.amountMinor)}</dd>
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
                loading={process.isPending}
                onClick={() => process.mutate('APPROVE')}
              >
                Approve & refund
              </Button>
              <Button
                variant="danger"
                className="w-full"
                loading={process.isPending}
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
    </div>
  );
}
