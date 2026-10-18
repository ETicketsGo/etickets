'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReferenceCode } from '@/components/reference-code';
import { useEffect, useMemo, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { CalendarDays, MessageSquareWarning, Receipt } from 'lucide-react';
import {
  BRAND_FOCUS,
  BrandButton,
  api as webKit,
  brandButtonClasses,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { PriceBreakdown } from '@/components/price-breakdown';
import { Drawer } from '@/components/ui';
import {
  ACCOUNT_PANEL,
  AccountHeading,
  AccountPage,
  AccountStatusPill,
  BrandError,
  BrandTextareaField,
} from '@/components/account-brand';
import { BRAND_EYEBROW, BRAND_LINK } from '@/components/booking-brand';
import { Placeholder } from '@/components/home/parts';
import { BrandEmpty } from '@/components/storefront-brand';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/lib/use-mounted';
import { useStatusLabel } from '@/lib/status-label';
import { splitBookings } from '@/lib/booking-list';

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

/** A quiet sunken box inside the drawer: an offer, or a request already on its way. */
const DRAWER_NOTE = 'rounded-brand-card bg-brand-sunken p-4';

/** A danger action in brand tokens: critical on its tint, words always. */
const DANGER_BUTTON = `inline-flex h-11 items-center justify-center gap-2 rounded-brand-control bg-brand-critical px-5 text-brand-ui font-semibold text-brand-surface transition-opacity duration-150 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50 ${BRAND_FOCUS}`;

/*
  My bookings on the brand layer (docs/design/DESIGN-SYSTEM.md): each booking as a flat white
  panel on paper with its state as a word in a pill, and the drawer's insides in brand tokens.
  It was grey with shadowed cards that lifted on hover, blue outline buttons and the kit's
  coloured badges. The same list, paging, past toggle, drawer, refund and cancel rules.
*/

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

  const [showPast, setShowPast] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ['bookings'],
    queryFn: ({ pageParam }) => api.listBookings(pageParam),
    initialPageParam: 1,
    // Pages of 50, asked for on demand, so nothing is cut off at the first page.
    getNextPageParam: (last) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
    // Not `typeof window`: that differs between the server and the first client render, which
    // is the React #418 QA saw on every load. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  // `mounted` first: the clock differs between the server and the first client render.
  const { current, past } = useMemo(() => splitBookings(rows, Date.now()), [rows]);
  const visible = showPast ? rows : current;

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
    <AccountPage spaced={false}>
      <div className="space-y-8">
        <AccountHeading title={a('bookingsHeading')} lead={a('bookingsLead')} />

        {list.isError ? (
          <BrandError message={a('bookingsLoadError')} onRetry={() => list.refetch()} />
        ) : !mounted || list.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Placeholder key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : rows.length > 0 ? (
          <div className="space-y-3">
            {/*
            The way back to everything that is not current. A toggle button (aria-pressed), not
            a filter that quietly drops rows: the count says how many are out of sight.
          */}
            {past.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p className="text-brand-meta text-brand-ink-2" role="status">
                  {showPast ? '' : a('pastBookingsHidden', { count: past.length })}
                </p>
                <BrandButton
                  variant="secondary"
                  aria-pressed={showPast}
                  onClick={() => setShowPast((v) => !v)}
                >
                  {showPast ? a('hidePastBookings') : a('showPastBookings')}
                </BrandButton>
              </div>
            )}
            {visible.length === 0 && (
              <p className="text-brand-ui text-brand-ink-2">{a('noCurrentBookings')}</p>
            )}
            {/*
            A card with one control that opens it, not a button wrapping the whole card.

            The row was a <button> containing the reference's own Copy button — a button inside
            a button, which a screen reader cannot operate and axe reports as nested-interactive.
            The title is the button now, named by the event, and its ::after stretches over the
            card so a click anywhere still opens it; the reference sits above that layer so its
            Copy button stays its own control.
          */}
            {visible.map((row) => (
              <div
                key={row.id}
                className={`relative flex w-full items-center justify-between gap-4 ${ACCOUNT_PANEL} p-5 text-left transition-colors duration-150 focus-within:ring-2 focus-within:ring-brand-focus focus-within:ring-offset-2 focus-within:ring-offset-brand-canvas hover:border-brand-ink-3`}
              >
                <div className="min-w-0">
                  <p className="font-brand-display text-brand-card text-brand-ink">
                    <button
                      type="button"
                      onClick={() => setSelectedId(row.id)}
                      className="block w-full truncate text-left after:absolute after:inset-0 after:rounded-brand-card after:content-[''] focus-visible:outline-none"
                    >
                      {row.event.title}
                    </button>
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-brand-meta tabular-nums text-brand-ink-2">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {/*
                    The venue's clock, named, as in the drawer. This row used the reader's browser
                    zone, so on QA it printed a different time from the drawer it opens.
                  */}
                    {dateTime(row.eventSession.startsAt, undefined, row.timeZone ?? undefined)}
                    {row.timeZone
                      ? ` (${zoneAbbrev(row.eventSession.startsAt, row.timeZone)})`
                      : ''}
                    {ticketCount(row) && ` - ${ticketCount(row)}`}
                  </p>
                  {row.reference && (
                    <p className="relative z-10 mt-1 w-fit text-brand-meta text-brand-ink-2">
                      <ReferenceCode value={row.reference} label={c('bookingReference')} />
                    </p>
                  )}
                </div>
                <span className="shrink-0">
                  <AccountStatusPill
                    status={row.status}
                    label={statusLabel('booking', row.status)}
                  />
                </span>
              </div>
            ))}
            {list.hasNextPage && (
              <BrandButton
                variant="secondary"
                className="w-full"
                aria-busy={list.isFetchingNextPage || undefined}
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {a('loadOlderBookings')}
              </BrandButton>
            )}
          </div>
        ) : (
          <BrandEmpty
            title={a('noBookingsTitle')}
            hint={a('noBookingsHint')}
            headingLevel="h2"
            action={
              <Link href="/events" className={brandButtonClasses('primary', 'md')}>
                <Receipt className="h-4 w-4" aria-hidden />
                {n('browseEvents')}
              </Link>
            }
          />
        )}
      </div>

      {/*
        Outside the spaced column, on purpose: `space-y-8` gives every later sibling a top margin,
        and the drawer is `position: fixed; inset: 0`. The margin moved it 32px down, so on a
        phone the site header showed above the panel.
      */}
      <Drawer open={!!selectedId} onClose={closeDrawer} title={a('bookingDetails')}>
        {detail.isError ? (
          <BrandError message={a('detailsLoadError')} onRetry={() => detail.refetch()} />
        ) : detail.isLoading || !b ? (
          <Placeholder className="h-64 w-full" />
        ) : (
          <div className="space-y-5 font-brand-text text-brand-ink">
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="font-brand-display text-brand-card text-brand-ink">{b.event.title}</p>
                <AccountStatusPill status={b.status} label={statusLabel('booking', b.status)} />
              </div>
              <p className="mt-1 text-brand-ui tabular-nums text-brand-ink-2">
                {/* The cinema's clock, named — see the API comment on `timeZone`. */}
                {dateTime(b.eventSession.startsAt, undefined, b.timeZone ?? undefined)}
                {b.timeZone ? (
                  <span className="text-brand-ink-2">
                    {' '}
                    ({zoneAbbrev(b.eventSession.startsAt, b.timeZone)})
                  </span>
                ) : null}
              </p>
              {b.reference && (
                <p className="mt-1 font-mono text-brand-meta text-brand-ink-2">
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
            <div className={`${ACCOUNT_PANEL} p-4 [&>div]:border-t-0 [&>div]:pt-0`}>
              <PriceBreakdown
                brand
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
            </div>

            <div>
              <p className={`mb-2 ${BRAND_EYEBROW}`}>
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
                    className="flex items-center justify-between gap-3 rounded-brand-control border border-brand-line bg-brand-surface px-3 py-2 text-brand-ui"
                  >
                    <span className="min-w-0 text-brand-ink">
                      {t.seatLabel ? (
                        <>
                          {w('seat')} <strong>{t.seatLabel}</strong>
                        </>
                      ) : (
                        (t.ticketTypeName ?? w('generalAdmission'))
                      )}
                      {t.seatLabel && t.ticketTypeName ? (
                        <span className="text-brand-ink-2"> - {t.ticketTypeName}</span>
                      ) : null}
                    </span>
                    <AccountStatusPill status={t.status} label={statusLabel('ticket', t.status)} />
                  </li>
                ))}
              </ul>
            </div>

            {/* Existing refunds */}
            {refunds.data && refunds.data.length > 0 && (
              <div>
                <p className={`mb-2 ${BRAND_EYEBROW}`}>{a('refundsHeading')}</p>
                <ul className="space-y-1.5">
                  {refunds.data.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-3 rounded-brand-control border border-brand-line bg-brand-surface px-3 py-2 text-brand-ui"
                    >
                      <span className="tabular-nums text-brand-ink">
                        {money(r.amountMinor, b.currency)}
                      </span>
                      <AccountStatusPill
                        status={r.status}
                        label={statusLabel('refund', r.status)}
                      />
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
                  <div className={DRAWER_NOTE}>
                    <p className="font-semibold text-brand-ink">{a('unpaidTitle')}</p>
                    <p className="mt-1 text-brand-meta text-brand-ink-2">{a('unpaidBody')}</p>
                    {confirmingCancel ? (
                      <div className="mt-3 space-y-2">
                        <p className="text-brand-ui text-brand-ink">
                          {a('confirmCancelBookingTitle')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <BrandButton
                            variant="secondary"
                            className="flex-1"
                            disabled={cancelBooking.isPending}
                            onClick={() => setConfirmingCancel(false)}
                          >
                            {a('keepBooking')}
                          </BrandButton>
                          <button
                            type="button"
                            className={`${DANGER_BUTTON} flex-1`}
                            aria-busy={cancelBooking.isPending || undefined}
                            disabled={cancelBooking.isPending}
                            onClick={() => cancelBooking.mutate()}
                          >
                            {a('confirmCancelBooking')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <BrandButton
                        variant="secondary"
                        className="mt-3 w-full"
                        onClick={() => setConfirmingCancel(true)}
                      >
                        {a('cancelBooking')}
                      </BrandButton>
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
                  <div className={DRAWER_NOTE}>
                    <p className="font-semibold text-brand-ink">{a('refundRequestedTitle')}</p>
                    <p className="mt-1 text-brand-meta text-brand-ink-2">
                      {a('refundRequestedBody', {
                        amount: money(openRefund.amountMinor, b.currency),
                      })}
                    </p>
                  </div>
                );
              }
              if (!offered && REFUNDABLE.includes(b.status) && hasActive) {
                return (
                  <div className={DRAWER_NOTE}>
                    <p className="font-semibold text-brand-ink">{a('refundsNotOffered')}</p>
                    <p className="mt-1 text-brand-meta text-brand-ink-2">
                      {a('refundsNotOfferedBody')}
                      {b.event.title ? ` ${a('contactOrganizer')}` : ''}
                    </p>
                  </div>
                );
              }
              if (!canAsk) return null;
              return (
                <div className={DRAWER_NOTE}>
                  <p className="font-semibold text-brand-ink">
                    {free ? a('cancelTickets') : a('requestRefund')}
                  </p>
                  <p className="mt-1 text-brand-meta text-brand-ink-2">
                    {free ? a('cancelTicketsBody') : a('refundEligibility')}
                  </p>
                  <div className="mt-3">
                    <BrandTextareaField
                      id="reason"
                      // The placeholder is not a name: it vanishes once somebody types.
                      aria-label={a('refundReasonLabel')}
                      rows={3}
                      placeholder={
                        free ? a('cancelReasonPlaceholder') : a('refundReasonPlaceholder')
                      }
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className={`${DANGER_BUTTON} mt-3 w-full`}
                    aria-busy={requestRefund.isPending || undefined}
                    disabled={requestRefund.isPending || (!free && reason.trim().length < 3)}
                    onClick={() => requestRefund.mutate({ free })}
                  >
                    {free ? a('cancelTickets') : a('requestRefundButton')}
                  </button>
                </div>
              );
            })()}

            {/*
              Where a complaint starts.

              Not the same thing as a refund. A refund asks for money back and goes to the
              organizer to approve; a complaint says something was wrong and is recorded against
              the seller for the platform to act on. There was no way to raise one at all, so
              every grievance arrived as a general contact message that could not be attributed
              to anybody - which is also why we could not answer how many were open against a
              given organizer.

              The booking id goes with it, and the API derives the organizer from that.
            */}
            <Link
              href={`/help/complaint?booking=${b.id}`}
              className={`inline-flex min-h-11 items-center gap-1.5 text-brand-ui ${BRAND_LINK}`}
            >
              <MessageSquareWarning className="h-4 w-4" aria-hidden />
              {a('reportProblem')}
            </Link>
          </div>
        )}
      </Drawer>
    </AccountPage>
  );
}
