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
  type Column,
  type Payout,
} from '@eticketsgo/web-kit';

const STATUSES = ['PENDING', 'SCHEDULED', 'PAID', 'FAILED'];
const PAGE_SIZE = 15;

export default function AdminPayouts() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Payout | null>(null);
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
    {
      key: 'gross',
      header: 'Gross',
      render: (p) => money(p.grossMinor),
      sortable: true,
      sortValue: (p) => p.grossMinor,
    },
    {
      key: 'net',
      header: 'Net',
      render: (p) => <span className="font-semibold">{money(p.netMinor)}</span>,
      sortable: true,
      sortValue: (p) => p.netMinor,
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
          <p>
            Confirm settlement of <strong>{money(confirm.netMinor)}</strong> to{' '}
            {confirm.organization?.name ?? 'this organizer'}.
          </p>
        )}
      </Dialog>
    </div>
  );
}
