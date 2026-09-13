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
  Dialog,
  ErrorState,
  money,
  dateTime,
  useToast,
  errorMessage,
  priceBreakdown,
  moneyFractionDigits,
  type FeeTaxPart,
  type RefundRow,
} from '@eticketsgo/web-kit';

/** GST components named in full, as the buyer's checkout and receipt name them. */
const GST_NAMES: Record<string, string> = {
  IGST: 'Integrated GST (IGST)',
  CGST: 'Central GST (CGST)',
  SGST: 'State GST (SGST)',
  UTGST: 'Union Territory GST (UTGST)',
};

function feeTaxLabel(tax: FeeTaxPart): string {
  const rate = `${(tax.rateBasisPoints / 100).toFixed(tax.rateBasisPoints % 100 === 0 ? 0 : 2)}%`;
  if (tax.label === null) return tax.rateBasisPoints > 0 ? `GST @ ${rate}` : 'Tax on fees';
  return `${GST_NAMES[tax.label.trim().toUpperCase()] ?? tax.label} @ ${rate}`;
}

export default function AdminBookingDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmApprove, setConfirmApprove] = useState<RefundRow | null>(null);

  const bookingQ = useQuery({ queryKey: ['booking', id], queryFn: () => api.bookings.get(id) });
  const refundsQ = useQuery({
    queryKey: ['booking', id, 'refunds'],
    queryFn: () => api.refunds.forBooking(id),
  });

  const process = useMutation({
    mutationFn: ({ refundId, decision }: { refundId: string; decision: 'APPROVE' | 'REJECT' }) =>
      api.refunds.process(refundId, decision),
    onSuccess: () => {
      toast.push('Refund processed.', 'success');
      setConfirmApprove(null);
      qc.invalidateQueries({ queryKey: ['booking', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const b = bookingQ.data;
  if (bookingQ.isError)
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => bookingQ.refetch()}
      />
    );
  if (bookingQ.isLoading || !b) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Booking"
        breadcrumbs={[{ label: 'Bookings', href: '/admin/bookings' }, { label: b.event.title }]}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Summary">
          <dl className="space-y-2 text-sm">
            <Row label="Booking ID" value={b.id} mono />
            <Row label="Event" value={b.event.title} />
            <Row label="Session" value={dateTime(b.eventSession.startsAt)} />
            <Row label="Buyer" value={`${b.buyerName} · ${b.buyerEmail}`} />
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <StatusBadge status={b.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Payment</dt>
              <dd>{b.payment ? <StatusBadge status={b.payment.status} /> : '—'}</dd>
            </div>
          </dl>
        </Card>

        {/*
          The same breakdown the buyer was shown, from the same arithmetic.

          This listed the full booking fee and payment fee and the total — no GST on the fees,
          and, when the organizer covered part of the fees, two figures that were not what the
          buyer paid. Support reading this page to answer a buyer needs the buyer's numbers:
          tickets, payment processing and convenience fees — each with its base amount and its
          own GST lines named, as the buyer's checkout shows them — and the total.
        */}
        <Card title="Amounts">
          {(() => {
            const breakdown = priceBreakdown({
              subtotalMinor: b.subtotalMinor,
              discountMinor: b.discountMinor,
              bookingFeeMinor: b.bookingFeeMinor,
              paymentFeeMinor: b.paymentFeeMinor,
              customerFeeInclusiveMinor: b.customerFeeInclusiveMinor,
              customerFeeMinor: b.customerFeeMinor,
              feeTaxRateBasisPoints: b.feeTaxRateBasisPoints,
              maintenanceMinor: b.maintenanceMinor,
              maintenanceTreatment: b.maintenanceTreatment,
              taxLines: b.taxLines,
              totalMinor: b.totalMinor,
            });
            // One number of decimals for the card, so "₹1,598" never sits above "₹32.36".
            // Each fee's GST share can carry paise the rows do not, so the groups count too.
            const digits = moneyFractionDigits(
              [
                ...breakdown.rows.map((r) => r.amountMinor),
                ...breakdown.feeGroups.flatMap((g) => [
                  g.totalMinor,
                  g.baseMinor,
                  ...g.taxLines.map((t) => t.amountMinor),
                ]),
                b.totalMinor,
              ],
              b.currency,
            );
            const fmt = (minor: number) => money(minor, b.currency, undefined, digits);
            const part = (kind: string) => breakdown.rows.find((r) => r.kind === kind);
            const feeRows = breakdown.rows.filter((r) =>
              ['paymentFee', 'platformFee', 'feeTax', 'fees'].includes(r.kind),
            );
            const feesTotal = feeRows.reduce((sum, r) => sum + r.amountMinor, 0);
            return (
              <>
                <dl className="space-y-2 text-sm">
                  <Row label="Tickets" value={fmt(b.subtotalMinor)} />
                  {b.discountMinor > 0 && (
                    <Row label="Discount" value={`- ${fmt(b.discountMinor)}`} />
                  )}
                  {part('maintenance') && (
                    <Row
                      label="Maintenance charges"
                      value={fmt(part('maintenance')!.amountMinor)}
                    />
                  )}
                  {breakdown.rows
                    .filter((r) => r.kind === 'tax')
                    .map((r) => (
                      <Row
                        key={`tax-${r.label}-${r.rateBasisPoints}`}
                        label={`${r.label} (${(r.rateBasisPoints ?? 0) / 100}%)`}
                        value={fmt(r.amountMinor)}
                      />
                    ))}
                  {breakdown.feeGroups.length > 0
                    ? breakdown.feeGroups.map((group) => (
                        <div key={group.kind} className="space-y-1">
                          <Row
                            label={
                              group.kind === 'paymentFee'
                                ? 'Payment processing fee'
                                : 'Convenience fees'
                            }
                            value={fmt(group.totalMinor)}
                          />
                          {group.taxLines.length > 0 && (
                            <div className="space-y-1 border-l-2 border-border pl-3 text-xs">
                              <SubRow label="Base amount" value={fmt(group.baseMinor)} />
                              {group.taxLines.map((tax) => (
                                <SubRow
                                  key={`fee-tax-${tax.label ?? 'combined'}-${tax.rateBasisPoints}`}
                                  label={feeTaxLabel(tax)}
                                  value={fmt(tax.amountMinor)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    : feesTotal > 0 && <Row label="Convenience fees" value={fmt(feesTotal)} />}
                  <Row label="Total" value={fmt(b.totalMinor)} />
                </dl>
                {breakdown.includedTax.length > 0 && (
                  <p className="mt-2 text-xs text-text-muted">
                    Ticket price includes{' '}
                    {breakdown.includedTax
                      .map(
                        (tax) =>
                          `${GST_NAMES[tax.label.trim().toUpperCase()] ?? tax.label} ${fmt(tax.amountMinor)}`,
                      )
                      .join(', ')}
                    .
                  </p>
                )}
              </>
            );
          })()}
        </Card>
      </div>

      <Card title={`Tickets (${b.tickets.length})`}>
        {b.tickets.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {b.tickets.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2">
                <span className="font-mono text-xs text-text-muted">{t.id}</span>
                <StatusBadge status={t.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No tickets on this booking.</p>
        )}
      </Card>

      <Card title="Refunds">
        {refundsQ.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : refundsQ.data && refundsQ.data.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {refundsQ.data.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-text-primary">{money(r.amountMinor, b.currency)}</p>
                  <p className="text-xs text-text-muted">{r.reason}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  {r.status === 'REQUESTED' && (
                    <>
                      <Button
                        loading={
                          process.isPending &&
                          process.variables?.refundId === r.id &&
                          process.variables?.decision === 'APPROVE'
                        }
                        disabled={process.isPending}
                        onClick={() => setConfirmApprove(r)}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        loading={
                          process.isPending &&
                          process.variables?.refundId === r.id &&
                          process.variables?.decision === 'REJECT'
                        }
                        disabled={process.isPending}
                        onClick={() => process.mutate({ refundId: r.id, decision: 'REJECT' })}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No refunds for this booking.</p>
        )}
      </Card>

      <Dialog
        open={!!confirmApprove}
        onClose={() => setConfirmApprove(null)}
        title="Approve this refund?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmApprove(null)}>
              Cancel
            </Button>
            <Button
              loading={process.isPending && process.variables?.decision === 'APPROVE'}
              onClick={() =>
                confirmApprove &&
                process.mutate({ refundId: confirmApprove.id, decision: 'APPROVE' })
              }
            >
              Approve &amp; refund
            </Button>
          </>
        }
      >
        {confirmApprove && (
          <p>
            This will refund <strong>{money(confirmApprove.amountMinor, b.currency)}</strong> to the
            buyer. This action cannot be undone.
          </p>
        )}
      </Dialog>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`text-right text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

/** A part of the row above it — listed beneath, never added to the total a second time. */
function SubRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right tabular-nums text-text-secondary">{value}</dd>
    </div>
  );
}
