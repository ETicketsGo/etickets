'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ExternalLink, ReceiptText } from 'lucide-react';
import {
  api,
  Badge,
  Card,
  DataTable,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  money,
  dateOnly,
  type Column,
  type ReceiptListRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const KIND_LABEL: Record<string, string> = {
  TAX_INVOICE: 'Tax invoice',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit note',
};

export default function ReceiptsPage() {
  const { activeOrg } = useOrg();
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['receipts', activeOrg.id, page, from, to],
    queryFn: () =>
      api.organizations.receipts(activeOrg.id, {
        page,
        pageSize: 25,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
  });

  const columns: Column<ReceiptListRow>[] = [
    {
      key: 'number',
      header: 'Number',
      render: (r) => <span className="font-medium tabular-nums">{r.number}</span>,
    },
    {
      key: 'kind',
      header: 'Type',
      render: (r) => (
        <Badge tone={r.kind === 'CREDIT_NOTE' ? 'warning' : undefined}>
          {KIND_LABEL[r.kind] ?? r.kind}
        </Badge>
      ),
    },
    { key: 'issued', header: 'Issued', render: (r) => dateOnly(r.issuedAt) },
    {
      key: 'buyer',
      header: 'Customer',
      render: (r) => (
        <div>
          <div>{r.booking.buyerName}</div>
          <div className="text-caption text-text-muted">{r.booking.reference ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'tax',
      header: 'Tax',
      render: (r) => (
        <span className="tabular-nums">
          {r.taxMinor === 0 ? '—' : money(r.taxMinor, r.currency)}
        </span>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      render: (r) => (
        <span className="tabular-nums font-medium">{money(r.totalMinor, r.currency)}</span>
      ),
    },
    {
      key: 'open',
      header: '',
      render: (r) => (
        <a
          href={api.receipts.htmlUrl(r.id)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-caption text-brand hover:underline"
        >
          Open <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ),
    },
  ];

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receipts and invoices"
        description="Every financial document issued for your sales, exactly as the customer received it."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <Input
            id="from"
            type="date"
            label="Issued from"
            value={from}
            onChange={(e) => {
              setPage(1);
              setFrom(e.target.value);
            }}
          />
          <Input
            id="to"
            type="date"
            label="Issued to"
            value={to}
            onChange={(e) => {
              setPage(1);
              setTo(e.target.value);
            }}
          />
        </div>
      </Card>

      {isError ? (
        <ErrorState
          message="We couldn't load your documents. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.items.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ReceiptText className="h-8 w-8 text-text-muted" />
            <p className="text-text-primary">No documents yet.</p>
            <p className="max-w-md text-caption text-text-secondary">
              A receipt is issued automatically the moment a booking is paid for. Once you add your
              tax registration in Settings, new sales are documented as tax invoices instead.
            </p>
          </div>
        </Card>
      ) : (
        <>
          <DataTable columns={columns} rows={data.items} rowKey={(r) => r.id} />
          {totalPages > 1 ? (
            <div className="flex items-center justify-between text-caption text-text-secondary">
              <span>
                Page {data.page} of {totalPages} · {data.total} documents
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
    </div>
  );
}
