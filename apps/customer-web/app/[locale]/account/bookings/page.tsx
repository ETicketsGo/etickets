'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReferenceCode } from '@/components/reference-code';
import { useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { CalendarDays, Receipt } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatusBadge,
  Textarea,
  api as webKit,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { PriceBreakdown } from '@/components/price-breakdown';
import { ButtonLink, Drawer, ErrorState } from '@/components/ui';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/lib/use-mounted';
import { useStatusLabel } from '@/lib/status-label';

const REFUNDABLE = ['CONFIRMED', 'PARTIALLY_REFUNDED'];

/*
  A refund still being worked on, so the buyer is not offered a second one.

  APPROVED belongs here: the organizer has said yes and the money has not moved yet. Without
  it the request form came back the moment a refund was approved, inviting a duplicate
  request against a refund that was already on its way.
*/
const OPEN_REFUND_STATUSES = ['REQUESTED', 'APPROVED', 'PROCESSING'];

/*
  What a free cancellation records when the buyer gives no reason.

  It goes through the refund request, which requires a reason, and giving back a ticket that
  cost nothing should not make anybody justify it. This stands in, in the audit log only —
  nothing shows it to the buyer or the organizer.
*/
const FREE_CANCEL_REASON = 'Free tickets cancelled by the buyer';

export default function BookingsPage() {
  const n = useTranslations('common.nav');
  const a = useTranslations('storefront.account');
  const c = useTranslations('storefront.confirmation');
  const w = useTranslations('storefront.wallet');
  const { money, dateTime, zoneAbbrev } = useFormat();
  const statusLabel = useStatusLabel();
  const mounted = useMounted();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/bookings');
  }, [router]);

  const list = useQuery({
    queryKey: ['bookings'],
    queryFn: () => api.listBookings(),
    // Not `typeof window`: that differs between the server and the first client render, which
    // is the React #418 QA saw on every load. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });

  const detail = useQuery({
    queryKey: ['booking', selectedId],
    queryFn: () => api.getBooking(selectedId!),
    enabled: !!selectedId,
  });
  const refunds = useQuery({
    queryKey: ['refunds', selectedId],
    queryFn: () => api.refundsForBooking(selectedId!),
    enabled: !!selectedId,
  });

  const requestRefund = useMutation({
    /*
      A free booking goes through the same request, and the API cancels its tickets at once
      rather than queueing a refund of nothing — so a reason is optional there.
    */
    mutationFn: ({ free }: { free: boolean }) =>
      api.requestRefund({
        bookingId: selectedId!,
        reason: free && reason.trim().length < 3 ? FREE_CANCEL_REASON : reason,
      }),
    onSuccess: (_result, { free }) => {
      toast.push(free ? a('ticketsCancelledToast') : a('refundRequestedToast'), 'success');
      setReason('');
      qc.invalidateQueries({ queryKey: ['refunds', selectedId] });
      qc.invalidateQueries({ queryKey: ['booking', selectedId] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /*
    Letting go of an unpaid booking from the list as well as from the payment screen, because
    this is where somebody who closed that tab finds it again. The server cancels only a booking
    still awaiting payment; one paid or expired in the meantime is refused, and re-reading it
    shows the buyer which.
  */
  const cancelBooking = useMutation({
    mutationFn: () => webKit.bookings.cancel(selectedId!),
    onSuccess: () => {
      toast.push(a('bookingCancelledToast'), 'success');
      setConfirmingCancel(false);
      qc.invalidateQueries({ queryKey: ['booking', selectedId] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
    },
    onError: (e) => {
      setConfirmingCancel(false);
      toast.push(errorMessage(e), 'error');
      qc.invalidateQueries({ queryKey: ['booking', selectedId] });
    },
  });

  const closeDrawer = () => {
    setSelectedId(null);
    setConfirmingCancel(false);
  };

  /**
   * How many tickets to claim this booking has.
   *
   * ── WHY NOT JUST `_count.tickets` ──────────────────────────────────────────────────
   * Tickets are issued on confirmation, so an order still being paid for has none — and the
   * list said "0 ticket(s)" next to PENDING PAYMENT. To the person who has just typed their
   * card in, that reads as "your money went somewhere and you got nothing", which is the worst
   * possible reading of a screen that is simply waiting. Observed on QA and reported as
   * "after payment it is still showing pending payment".
   *
   * A count is only meaningful once there is something to count. Before that the status badge
   * beside it already says what is happening, so this says nothing rather than something wrong.
   */
  const ticketCount = (row: { _count: { tickets: number } }): string =>
    row._count.tickets === 0 ? '' : a('ticketCount', { count: row._count.tickets });

  const b = detail.data;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">
          {a('bookingsHeading')}
        </h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">{a('bookingsLead')}</p>
      </div>

      {list.isError ? (
        <ErrorState message={a('bookingsLoadError')} onRetry={() => list.refetch()} />
      ) : !mounted || list.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : list.data && list.data.data.length > 0 ? (
        <div className="space-y-3">
          {/*
            A card with one control that opens it, not a button wrapping the whole card.

            The row was a <button> containing the reference's own Copy button — a button inside
            a button, which a screen reader cannot operate and axe reports as nested-interactive.
            The title is the button now, named by the event, and its ::after stretches over the
            card so a click anywhere still opens it; the reference sits above that layer so its
            Copy button stays its own control.
          */}
          {list.data.data.map((row) => (
            <div
              key={row.id}
              className="relative flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-background-surface p-5 text-left shadow-sm transition-all focus-within:ring-2 focus-within:ring-ring/50 hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="min-w-0">
                <p className="font-semibold text-text-primary">
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className="block w-full truncate text-left after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none"
                  >
                    {row.event.title}
                  </button>
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-caption text-text-muted">
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                  {/*
                    The venue's clock, named, as in the drawer. This row used the reader's browser
                    zone, so on QA it printed a different time from the drawer it opens.
                  */}
                  {dateTime(row.eventSession.startsAt, undefined, row.timeZone ?? undefined)}
                  {row.timeZone ? ` (${zoneAbbrev(row.eventSession.startsAt, row.timeZone)})` : ''}
                  {ticketCount(row) && ` · ${ticketCount(row)}`}
                </p>
                {row.reference && (
                  <p className="relative z-10 mt-1 w-fit text-caption text-text-muted">
                    <ReferenceCode value={row.reference} label={c('bookingReference')} />
                  </p>
                )}
              </div>
              <StatusBadge status={row.status} label={statusLabel('booking', row.status)} />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title={a('noBookingsTitle')}
          hint={a('noBookingsHint')}
          icon={Receipt}
          action={<ButtonLink href="/events">{n('browseEvents')}</ButtonLink>}
        />
      )}

      <Drawer open={!!selectedId} onClose={closeDrawer} title={a('bookingDetails')}>
        {detail.isError ? (
          <ErrorState message={a('detailsLoadError')} onRetry={() => detail.refetch()} />
        ) : detail.isLoading || !b ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-text-primary">{b.event.title}</p>
                <StatusBadge status={b.status} label={statusLabel('booking', b.status)} />
              </div>
              <p className="mt-1 text-[0.9375rem] text-text-muted">
                {/* The cinema's clock, named — see the API comment on `timeZone`. */}
                {dateTime(b.eventSession.startsAt, undefined, b.timeZone ?? undefined)}
                {b.timeZone ? (
                  <span className="text-text-muted">
                    {' '}
                    ({zoneAbbrev(b.eventSession.startsAt, b.timeZone)})
                  </span>
                ) : null}
              </p>
              {b.reference && (
                <p className="mt-1 font-mono text-caption text-text-muted">
                  {a('reference', { reference: b.reference })}
                </p>
              )}
            </div>

            {/*
              The same breakdown the buyer paid against, not a sum of its own.

              This added the booking and payment fees and called that "Fees", leaving out the
              GST on them: ₹499 + ₹20.18 under "Total paid ₹522.82". Two numbers that do not add
              up to the third, on the screen where somebody checks what they were charged.
            */}
            <Card className="p-4 [&>div]:border-t-0 [&>div]:pt-0">
              <PriceBreakdown
                quote={{
                  currency: b.currency,
                  subtotalMinor: b.subtotalMinor,
                  discountMinor: b.discountMinor,
                  bookingFeeMinor: b.bookingFeeMinor,
                  paymentFeeMinor: b.paymentFeeMinor,
                  customerFeeInclusiveMinor: b.customerFeeInclusiveMinor,
                  customerFeeMinor: b.customerFeeMinor,
                  feeTaxRateBasisPoints: b.feeTaxRateBasisPoints,
                  feeTaxMinor: b.feeTaxMinor,
                  maintenanceMinor: b.maintenanceMinor,
                  maintenanceTreatment: b.maintenanceTreatment,
                  taxLines: b.taxLines,
                  totalMinor: b.totalMinor,
                }}
                free={b.totalMinor === 0 && !b.payment}
                totalLabel={c('totalPaid')}
                note={null}
              />
            </Card>

            <div>
              <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                {a('ticketsList', { count: b.tickets.length })}
              </p>
              <ul className="space-y-1.5">
                {/*
                  A ticket a person can recognise.

                  This listed a truncated cuid — "cmt9co5zc0…" — which identifies a row to
                  the database and nothing at all to the buyer holding it. The seat is what
                  they care about; the id is a last resort for a general-admission ticket
                  that genuinely has nothing else to show.
                */}
                {b.tickets.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-[0.9375rem]"
                  >
                    <span className="min-w-0 text-text-primary">
                      {t.seatLabel ? (
                        <>
                          {w('seat')} <strong>{t.seatLabel}</strong>
                        </>
                      ) : (
                        (t.ticketTypeName ?? w('generalAdmission'))
                      )}
                      {t.seatLabel && t.ticketTypeName ? (
                        <span className="text-text-muted"> · {t.ticketTypeName}</span>
                      ) : null}
                    </span>
                    <StatusBadge status={t.status} label={statusLabel('ticket', t.status)} />
                  </li>
                ))}
              </ul>
            </div>

            {/* Existing refunds */}
            {refunds.data && refunds.data.length > 0 && (
              <div>
                <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  {a('refundsHeading')}
                </p>
                <ul className="space-y-1.5">
                  {refunds.data.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[0.9375rem]"
                    >
                      <span className="text-text-primary">{money(r.amountMinor, b.currency)}</span>
                      <StatusBadge status={r.status} label={statusLabel('refund', r.status)} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/*
              Whether to offer a refund — or, for a booking that cost nothing, a cancellation.

              Two reasons not to, both reported from QA:

                - A request is already open. Asking again does nothing except create a second
                  request for the organizer to work through, and it reads as though the first
                  one failed.
                - The organizer does not offer refunds for this event. Showing the button
                  anyway means the platform advertising terms the organizer never agreed to.

              A free booking used to be left out altogether, because there was no money to
              return — which left no way at all to give a free ticket back. It is offered as
              "Cancel tickets" now, and the API cancels them at once instead of queueing a refund
              of nothing for the organizer to approve.

              An unpaid booking gets an offer of its own: cancel it and release what it holds.
            */}
            {(() => {
              if (b.status === 'PENDING_PAYMENT') {
                /*
                  Confirmed in place rather than in a dialog: this is already inside a drawer,
                  and a modal over a modal fights it for focus and for Escape.
                */
                return (
                  <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                    <p className="font-medium text-text-primary">{a('unpaidTitle')}</p>
                    <p className="mt-1 text-caption text-text-muted">{a('unpaidBody')}</p>
                    {confirmingCancel ? (
                      <div className="mt-3 space-y-2">
                        <p className="text-[0.9375rem] text-text-primary">
                          {a('confirmCancelBookingTitle')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            className="flex-1"
                            disabled={cancelBooking.isPending}
                            onClick={() => setConfirmingCancel(false)}
                          >
                            {a('keepBooking')}
                          </Button>
                          <Button
                            variant="danger"
                            className="flex-1"
                            loading={cancelBooking.isPending}
                            onClick={() => cancelBooking.mutate()}
                          >
                            {a('confirmCancelBooking')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        className="mt-3 w-full"
                        onClick={() => setConfirmingCancel(true)}
                      >
                        {a('cancelBooking')}
                      </Button>
                    )}
                  </div>
                );
              }

              const openRefund = (refunds.data ?? []).find((r) =>
                OPEN_REFUND_STATUSES.includes(r.status),
              );
              const free = b.totalMinor <= 0;
              const offered = b.event.refundsEnabled !== false;
              const hasActive = b.tickets.some((t) => t.status === 'ACTIVE');
              const canAsk = REFUNDABLE.includes(b.status) && hasActive && !openRefund && offered;

              if (openRefund) {
                return (
                  <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                    <p className="font-medium text-text-primary">{a('refundRequestedTitle')}</p>
                    <p className="mt-1 text-caption text-text-muted">
                      {a('refundRequestedBody', {
                        amount: money(openRefund.amountMinor, b.currency),
                      })}
                    </p>
                  </div>
                );
              }
              if (!offered && REFUNDABLE.includes(b.status) && hasActive) {
                return (
                  <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                    <p className="font-medium text-text-primary">{a('refundsNotOffered')}</p>
                    <p className="mt-1 text-caption text-text-muted">
                      {a('refundsNotOfferedBody')}
                      {b.event.title ? ` ${a('contactOrganizer')}` : ''}
                    </p>
                  </div>
                );
              }
              if (!canAsk) return null;
              return (
                <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
                  <p className="font-medium text-text-primary">
                    {free ? a('cancelTickets') : a('requestRefund')}
                  </p>
                  <p className="mt-1 text-caption text-text-muted">
                    {free ? a('cancelTicketsBody') : a('refundEligibility')}
                  </p>
                  <Textarea
                    id="reason"
                    className="mt-3"
                    rows={3}
                    placeholder={free ? a('cancelReasonPlaceholder') : a('refundReasonPlaceholder')}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    variant="danger"
                    className="mt-3 w-full"
                    loading={requestRefund.isPending}
                    disabled={!free && reason.trim().length < 3}
                    onClick={() => requestRefund.mutate({ free })}
                  >
                    {free ? a('cancelTickets') : a('requestRefundButton')}
                  </Button>
                </div>
              );
            })()}
          </div>
        )}
      </Drawer>
    </div>
  );
}
