'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  Button,
  DataTable,
  StatusBadge,
  PageHeader,
  money,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
  type Payout,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

export default function PayoutsPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['payouts', activeOrg.id],
    queryFn: () => api.payouts.forOrg(activeOrg.id),
  });

  const generate = useMutation({
    mutationFn: () => api.payouts.generate(activeOrg.id),
    onSuccess: () => {
      toast.push('Settlement generated.', 'success');
      qc.invalidateQueries({ queryKey: ['payouts', activeOrg.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<Payout>[] = [
    { key: 'created', header: 'Created', render: (p) => dateOnly(p.createdAt) },
    { key: 'gross', header: 'Gross', render: (p) => money(p.grossMinor) },
    { key: 'fees', header: 'Fees', render: (p) => money(p.bookingFeeMinor + p.paymentFeeMinor) },
    { key: 'refunds', header: 'Refunds', render: (p) => money(p.refundMinor) },
    {
      key: 'net',
      header: 'Net',
      render: (p) => <span className="font-semibold">{money(p.netMinor)}</span>,
    },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'paid', header: 'Paid', render: (p) => (p.paidAt ? dateOnly(p.paidAt) : '—') },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payouts"
        description="Settlement records for your organization."
        action={
          <Button loading={generate.isPending} onClick={() => generate.mutate()}>
            Generate settlement
          </Button>
        }
      />
      <DataTable
        columns={columns}
        rows={data}
        loading={isLoading}
        rowKey={(p) => p.id}
        empty={
          <div className="p-8 text-center text-text-muted">
            No payouts yet. Generate a settlement to preview your net revenue.
          </div>
        }
      />
    </div>
  );
}
