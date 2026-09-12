'use client';

import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState, Skeleton, useToast } from '@/components/ui';

/**
 * Every receipt, invoice and credit note this account has been issued.
 *
 * ── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────────────
 * A document could be fetched for a BOOKING whose id you already had, or listed for an
 * ORGANIZATION you were a member of. A customer has neither to hand. So somebody who closed
 * the confirmation page without saving their receipt had no route back to it — the platform
 * had issued them a financial document and given them nowhere to find it.
 *
 * People need these after the fact and for unglamorous reasons: an expense claim weeks later,
 * a reimbursement, an accountant asking in April. "Find the email" is not an answer when the
 * email is the thing that was lost.
 */
const KIND_LABEL: Record<string, string> = {
  RECEIPT: 'Receipt',
  INVOICE: 'Invoice',
  CREDIT_NOTE: 'Credit note',
};

export default function ReceiptsPage() {
  const { dateOnly, money } = useFormat();
  const toast = useToast();
  const [opening, setOpening] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['receipts', 'mine'],
    queryFn: () => api.myReceipts({ pageSize: 50 }),
  });

  /*
    Opened through the authenticated fetch rather than as a link.

    A plain href sends no Authorization header — the token lives in localStorage, not a
    cookie — so the tab would open on a 401. That was reported once already from QA; this is
    the same helper the booking page uses.
  */
  const open = async (id: string) => {
    setOpening(id);
    try {
      await api.openReceiptHtml(id);
    } catch {
      toast.push('We could not open that document. Please try again.', 'error');
    } finally {
      setOpening(null);
    }
  };

  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h3 font-bold tracking-tight text-text-primary">Receipts</h1>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          Every receipt and invoice for your bookings. Open one to print it or save it as a PDF.
        </p>
      </div>

      {isError ? (
        <ErrorState message="We couldn't load your receipts. Please try again." onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_unused, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No receipts yet"
          hint="A receipt is issued when a booking is confirmed, and it will appear here."
          icon={FileText}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-text-primary">
                    {r.booking.event.title}
                  </p>
                  <p className="mt-1 text-caption text-text-muted">
                    {KIND_LABEL[r.kind] ?? r.kind} {r.number} · {dateOnly(r.issuedAt)}
                    {r.booking.reference && ` · ${r.booking.reference}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {/* The currency is the booking's, never a default — see `money`. */}
                  <span className="tabular-nums font-semibold text-text-primary">
                    {money(r.totalMinor, r.currency)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={opening === r.id}
                    onClick={() => open(r.id)}
                  >
                    Open
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
