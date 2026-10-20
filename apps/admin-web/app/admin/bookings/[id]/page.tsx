'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Card,
  Button,
  Skeleton,
  PageHeader,
  Dialog,
  ErrorState,
  money,
  useToast,
  errorMessage,
  priceBreakdown,
  moneyFractionDigits,
  timeAtVenue,
  recordedAt,
  type BookingDetail,
  type FeeTaxPart,
  type RefundRow,
} from '@eticketsgo/web-kit';
import { StatusBadge } from '@/components/status-badge';
import { MoneyStatusPill } from '@/components/money-status';
import { RecordHistory } from '@/components/record-history';
import { BookingMessages } from '@/components/booking-messages';
import { accountContactText } from '../../../../components/account-contact';

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

/**
 * The booking as the staff read returns it: the buyer's view plus the row's own dates and the
 * payment row, which `BookingDetail` does not declare because the buyer's screens never read them.
 */
type StaffBooking = BookingDetail & {
  createdAt?: string;
  confirmedAt?: string | null;
  cancelledAt?: string | null;
  payment:
    | (BookingDetail['payment'] & {
        id?: string;
        provider?: string;
        providerRef?: string | null;
        paidAt?: string | null;
        failureMessage?: string | null;
        refundedMinor?: number;
      })
    | null;
};

function providerName(provider?: string): string {
  if (!provider) return 'Unknown';
  return provider === 'razorpay'
    ? 'Razorpay'
    : provider === 'stripe'
      ? 'Stripe'
      : provider === 'mock'
        ? 'Test payment (no real money)'
        : provider;
}

export default function AdminBookingDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmApprove, setConfirmApprove] = useState<RefundRow | null>(null);
  const [confirmReject, setConfirmReject] = useState<RefundRow | null>(null);

  const bookingQ = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.bookings.getAsStaff(id),
  });
  const refundsQ = useQuery({
    queryKey: ['booking', id, 'refunds'],
    queryFn: () => api.refunds.forBooking(id),
  });

  const process = useMutation({
    mutationFn: ({ refundId, decision }: { refundId: string; decision: 'APPROVE' | 'REJECT' }) =>
      api.refunds.process(refundId, decision),
    onSuccess: (_r, { decision }) => {
      toast.push(
        decision === 'APPROVE'
          ? 'Refund approved and sent to the payment provider.'
          : 'Refund turned down. The buyer keeps their tickets.',
        'success',
      );
      setConfirmApprove(null);
      setConfirmReject(null);
      qc.invalidateQueries({ queryKey: ['booking', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const b = bookingQ.data as StaffBooking | undefined;
  if (bookingQ.isError)
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => bookingQ.refetch()}
      />
    );
  if (bookingQ.isLoading || !b) return <Skeleton className="h-64 w-full" />;

  /*
    What has actually gone back: the refunds paid out, or the payment's own running total if that
    says more (it is not kept by every provider path, so it can read 0 beside a paid refund).
  */
  const refundedMinor = Math.max(
    b.payment?.refundedMinor ?? 0,
    (refundsQ.data ?? [])
      .filter((r) => r.status === 'COMPLETED')
      .reduce((sum, r) => sum + r.amountMinor, 0),
  );

  return (
    <div className="space-y-6">
      {/*
        Named by the reference the customer quotes. The page was titled "Booking" and led with a
        database id, so the one thing a buyer reads out on the phone was nowhere on it.
      */}
      <PageHeader
        title={b.reference ?? 'Booking with no reference'}
        description={b.event.title}
        breadcrumbs={[
          { label: 'Bookings', href: '/admin/bookings' },
          { label: b.reference ?? b.event.title },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Summary">
          <dl className="space-y-2 text-sm">
            <Row label="Event" value={b.event.title} />
            {/*
              The show time at the venue, with its zone, like the ticket - it was printed in the
              reader's own clock with no zone, so it disagreed with what the buyer was holding.
            */}
            <Row label="Show" value={showTime(b.eventSession.startsAt, b.timeZone)} />
            {b.place && (
              <Row label="Where" value={[b.place.name, b.place.city].filter(Boolean).join(', ')} />
            )}
            <Row
              label="Buyer"
              value={[b.buyerName, accountContactText(b.buyerEmail)].filter(Boolean).join(' · ')}
            />
            <div className="flex justify-between">
              <dt className="text-text-muted">Booking</dt>
              <dd>
                <MoneyStatusPill entity="booking" status={b.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Payment</dt>
              <dd>
                {b.payment ? (
                  <MoneyStatusPill entity="payment" status={b.payment.status} />
                ) : (
                  'No payment'
                )}
              </dd>
            </div>
            {b.payment?.provider && (
              <Row
                label="Provider"
                value={[providerName(b.payment.provider), b.payment.providerRef]
                  .filter(Boolean)
                  .join(' - ')}
              />
            )}
            <Row label="Booking ID" value={b.id} mono />
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

      {/*
        Why the booking and the payment can read differently. On QA a booking said "Refunded"
        beside a payment that said "Partly refunded", with nothing to explain it: the tickets were
        refunded and the fees were not. Said here from the refunds themselves.
      */}
      {refundedMinor > 0 && (
        <Card title="Money back">
          <dl className="space-y-2 text-sm">
            <Row label="Paid" value={money(b.totalMinor, b.currency)} />
            <Row label="Refunded so far" value={money(refundedMinor, b.currency)} />
            <Row
              label="Not refunded"
              value={money(Math.max(0, b.totalMinor - refundedMinor), b.currency)}
            />
          </dl>
          {refundedMinor < b.totalMinor && (
            <p className="mt-2 text-caption text-text-muted">
              Not everything paid has been refunded. A refund returns the tickets it names and the
              tax on them; the booking and payment fees are kept unless the whole booking is
              cancelled.
            </p>
          )}
        </Card>
      )}

      <Card title={`Tickets (${b.tickets.length})`}>
        {b.tickets.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {b.tickets.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-text-primary">
                    {[t.ticketTypeName ?? 'Ticket', t.seatLabel ? `seat ${t.seatLabel}` : null]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  <p className="truncate font-mono text-xs text-text-muted">{t.id}</p>
                </div>
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
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <Link
                    href={`/admin/refunds/${r.id}`}
                    className="text-action-primary underline-offset-4 hover:underline"
                  >
                    {money(r.amountMinor, b.currency)}
                  </Link>
                  <p className="text-xs text-text-muted">
                    {r.reason} - asked {recordedAt(r.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <MoneyStatusPill entity="refund" status={r.status} />
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
                        onClick={() => setConfirmReject(r)}
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

      <BookingMessages bookingId={b.id} />

      <RecordHistory
        subjects={[
          `Booking:${b.id}`,
          ...(refundsQ.data ?? []).slice(0, 19).map((r) => `Refund:${r.id}`),
        ]}
      />

      <Dialog
        open={!!confirmReject}
        onClose={() => setConfirmReject(null)}
        title="Turn this refund down?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmReject(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={process.isPending && process.variables?.decision === 'REJECT'}
              onClick={() =>
                confirmReject && process.mutate({ refundId: confirmReject.id, decision: 'REJECT' })
              }
            >
              Turn it down
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          The buyer keeps their tickets and is not paid anything back.
        </p>
      </Dialog>

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

/** A show time at the venue's clock, with the zone named. Unknown zone: the reader's, said so. */
function showTime(iso: string, zone?: string | null): string {
  return timeAtVenue(iso, zone ?? null);
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
