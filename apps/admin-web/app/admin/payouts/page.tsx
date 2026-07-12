'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Button,
  Dialog,
  PageHeader,
  money,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
  type Payout,
} from '@eticketsgo/web-kit';

export default function AdminPayouts() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Payout | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'payouts'],
    queryFn: () => api.admin.payouts(),
  });

  const markPaid = useMutation({
    mutationFn: (payoutId: string) => api.admin.markPayoutPaid(payoutId),
    onSuccess: () => {
      toast.push('Payout marked as paid.', 'success');
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<Payout>[] = [
    {
      key: 'org',
      header: 'Organizer',
      render: (p) => p.organization?.name ?? p.organizationId.slice(0, 8),
    },
    { key: 'gross', header: 'Gross', render: (p) => money(p.grossMinor) },
    {
      key: 'net',
      header: 'Net',
      render: (p) => <span className="font-semibold">{money(p.netMinor)}</span>,
    },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'created', header: 'Created', render: (p) => dateOnly(p.createdAt) },
    {
      key: 'action',
      header: '',
      render: (p) =>
        p.status !== 'PAID' ? (
          <Button variant="outline" onClick={() => setConfirm(p)}>
            Mark paid
          </Button>
        ) : (
          <span className="text-text-muted">{dateOnly(p.paidAt)}</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Payouts" description="Organizer settlements across the platform." />
      <DataTable columns={columns} rows={data} loading={isLoading} rowKey={(p) => p.id} />

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
          <p>
            Confirm settlement of <strong>{money(confirm.netMinor)}</strong> to{' '}
            {confirm.organization?.name ?? 'this organizer'}.
          </p>
        )}
      </Dialog>
    </div>
  );
}
