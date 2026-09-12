'use client';

import { useQuery } from '@tanstack/react-query';
import { ReferenceCode } from '@/components/reference-code';
import { useParams } from 'next/navigation';
import {
  CalendarPlus,
  Check,
  ChevronRight,
  ReceiptText,
  Share2,
  Ticket,
  XCircle,
} from 'lucide-react';
import {
  Stepper,
  buildIcsDataUrl,
  moneyFractionDigits,
  useToast,
  type BookingDetail,
} from '@eticketsgo/web-kit';
import type { Locale } from '@eticketsgo/i18n';
import { api } from '@/lib/api';
import { money, dateTime } from '@/lib/format';
import { Link, getPathname } from '@/i18n/navigation';
import { EventCard } from '@/components/event-card';
import { PriceBreakdown } from '@/components/price-breakdown';
import { ButtonLink, Card, ErrorState, StatusBadge } from '@/components/ui';
import { useLocale, useTranslations } from 'next-intl';

const BOOKING_STEPS = ['tickets', 'payment', 'confirmation', 'ticket'] as const;
/*
  A free booking never had a payment step, so it does not get a ticked one.

  Showing "✓ Payment" over a booking that cost nothing says money changed hands, which is the
  one thing this whole path exists to avoid claiming — and it invites a support ticket asking
  what was charged and to which card.
*/
const FREE_BOOKING_STEPS = ['tickets', 'confirmation', 'ticket'] as const;

/** The one status that can still become CONFIRMED, and so the only one worth polling. */
const AWAITING_PAYMENT = 'PENDING_PAYMENT';

/*
  What to say about a booking that will never be confirmed.

  Every status other than CONFIRMED used to render "Booking pending — your payment has not
  completed yet" and poll every four seconds for ever. An expired hold is not pending: the
  seats are gone, and telling the buyer to wait sends them to wait for nothing. The payment
  page's "this booking is expired" state links here, so this is where that buyer lands.
  Anything not listed (a dispute, a status from a newer API) gets the neutral wording.
*/
const CLOSED_COPY = {
  EXPIRED: { title: 'expiredTitle', body: 'expiredBody' },
  CANCELLED: { title: 'cancelledTitle', body: 'cancelledBody' },
  REFUNDED: { title: 'refundedTitle', body: 'refundedBody' },
  PARTIALLY_REFUNDED: { title: 'partiallyRefundedTitle', body: 'partiallyRefundedBody' },
} as const;
const CLOSED_FALLBACK = { title: 'closedTitle', body: 'closedBody' } as const;

/** What a line of the order is called: its own label, else whatever it is an instance of. */
function itemName(item: BookingDetail['items'][number]): string {
  return item.label ?? item.ticketType?.name ?? item.addOn?.name ?? item.bundle?.name ?? '';
}

const SECONDARY_ACTION =
  'flex flex-1 items-center justify-center gap-2 rounded-md border border-border bg-background-surface px-4 py-2.5 text-[0.9375rem] font-medium text-text-primary shadow-sm transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas';

export default function ConfirmationPage() {
  const c = useTranslations('storefront.confirmation');
  const e = useTranslations('storefront.event');
  const w = useTranslations('storefront.wallet');
  const d = useTranslations('documents');
  const tx = useTranslations('common');
  const locale = useLocale() as Locale;
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const {
    data: booking,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
    // Confirmation arrives via an async signed webhook — poll while the booking is still
    // awaiting payment so the buyer isn't stranded on a "pending" screen. Every other status
    // is final: CONFIRMED is what we were waiting for, and an expired or cancelled booking
    // will not change however long the page keeps asking.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === AWAITING_PAYMENT ? 4000 : false;
    },
  });
  const upcoming = useQuery({
    queryKey: ['events', 'upcoming'],
    queryFn: () => api.listEvents({ pageSize: '3' }),
  });
  /*
    The tickets themselves, on the confirmation screen.

    Requested from QA: "once booking confirmed, along with confirmation show the tickets, do
    not need to click on view tickets". The QR is the thing the buyer came for and the thing
    they need at the door — putting it one click away on a page they have already reached is
    a step that earns nothing.

    Gated on CONFIRMED because tickets are minted at confirmation; before that there is
    nothing to fetch. The wallet returns every ticket the account holds, so it is filtered to
    this booking rather than showing somebody their whole history on a confirmation page.
  */
  const ticketsQ = useQuery({
    queryKey: ['tickets', 'wallet'],
    queryFn: () => api.wallet(),
    enabled: booking?.status === 'CONFIRMED',
  });

  // The document is issued in the same transaction that confirms the booking, so it exists
  // by the time the status flips — but only then. Gate the query on CONFIRMED rather than
  // polling for a document that cannot yet exist.
  const receipts = useQuery({
    queryKey: ['booking', id, 'receipts'],
    queryFn: () => api.bookingReceipts(id),
    enabled: booking?.status === 'CONFIRMED',
  });

  if (isError) return <ErrorState message={c('loadError')} onRetry={() => refetch()} />;
  if (isLoading || !booking)
    return <div className="h-64 animate-pulse rounded-lg bg-background-subtle" />;

  const confirmed = booking.status === 'CONFIRMED';
  const pending = booking.status === AWAITING_PAYMENT;
  const closed = !confirmed && !pending;
  const closedCopy = CLOSED_COPY[booking.status as keyof typeof CLOSED_COPY] ?? CLOSED_FALLBACK;
  /*
    Whether the seats are still held, so going back to pay can still work.

    Past the deadline the payment page can only say the tickets were released, so the way
    forward is the event page instead. The booking keeps polling either way: a payment made
    just before the deadline may still be confirmed by its webhook.
  */
  const holdLive = pending && new Date(booking.holdExpiresAt).getTime() > Date.now();
  /*
    Nothing was owed on this booking.

    Read from the booking's own total and the absence of a payment, not from a flag on the
    event: a booking is a settled fact and the event's setting can change afterwards. What
    the buyer is told about THIS booking must come from the booking.
  */
  const free = booking.totalMinor === 0 && !booking.payment;
  // The sale document. A credit note may also be present after a refund; the confirmation
  // screen shows the sale.
  const receipt = receipts.data?.find((r) => r.kind !== 'CREDIT_NOTE');
  const tickets = (ticketsQ.data ?? []).filter((t) => t.bookingId === id);
  const seats = booking.seatLabels ?? [];
  const items = booking.items.filter((item) => item.quantity > 0);
  // One number of decimals for the order lines, so ₹499 does not sit above ₹10.18.
  const itemDigits = moneyFractionDigits(
    [...items.map((item) => item.unitPriceMinor * item.quantity), booking.totalMinor],
    booking.currency,
  );
  const ics = buildIcsDataUrl({
    title: booking.event.title,
    description: c('icsDescription'),
    start: booking.eventSession.startsAt,
  });

  const share = async () => {
    // In the reader's language: a French buyer sharing with a French friend should send the
    // French page, and the default locale has no prefix to add.
    const url = `${window.location.origin}${getPathname({
      href: `/events/${booking.event.slug}`,
      locale,
    })}`;
    if (navigator.share)
      await navigator.share({ title: booking.event.title, url }).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      toast.push(c('linkCopied'), 'success');
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Stepper
        steps={(free ? FREE_BOOKING_STEPS : BOOKING_STEPS).map((k) => c(`steps.${k}`))}
        current={free ? 1 : confirmed ? 2 : 1}
      />

      <div className="text-center">
        <div
          className={`mx-auto flex h-16 w-16 animate-scale-in items-center justify-center rounded-full ${
            confirmed
              ? 'bg-tint-success text-status-success'
              : closed
                ? 'bg-background-subtle text-text-muted'
                : 'bg-tint-warning text-status-warning'
          }`}
          aria-hidden
        >
          {confirmed ? (
            <Check className="h-8 w-8" strokeWidth={2.5} />
          ) : closed ? (
            <XCircle className="h-8 w-8" />
          ) : (
            '…'
          )}
        </div>
        <h1 className="mt-4 text-h2 font-bold tracking-tight text-text-primary">
          {confirmed ? `${c('youreGoing')} 🎉` : closed ? c(closedCopy.title) : c('pending')}
        </h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-secondary">
          {confirmed
            ? c('sentTo', { count: booking.tickets.length, email: booking.buyerEmail })
            : closed
              ? c(closedCopy.body)
              : c('pendingBody')}
        </p>
      </div>

      {/* A way forward from every state that is not the one the buyer hoped for. */}
      {pending && (
        <ButtonLink
          href={holdLive ? `/booking/${booking.id}/payment` : `/events/${booking.event.slug}`}
          variant="outline"
          className="w-full"
        >
          {holdLive ? c('returnToPayment') : c('backToEvent')}
        </ButtonLink>
      )}
      {closed && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <ButtonLink href={`/events/${booking.event.slug}`} className="w-full sm:flex-1">
            {c('backToEvent')}
          </ButtonLink>
          <ButtonLink href="/account/bookings" variant="outline" className="w-full sm:flex-1">
            {c('myBookings')}
          </ButtonLink>
        </div>
      )}

      <Card className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-text-primary">{booking.event.title}</p>
            <StatusBadge status={booking.status} />
          </div>
          <p className="text-[0.9375rem] text-text-muted">
            {dateTime(booking.eventSession.startsAt, undefined, booking.timeZone ?? undefined)}
          </p>
        </div>

        {booking.reference && (
          <div className="flex items-center justify-between text-[0.9375rem]">
            <span className="text-text-secondary">{c('bookingReference')}</span>
            <ReferenceCode value={booking.reference} label={c('bookingReference')} />
          </div>
        )}

        {/*
          What was bought, before what it cost.

          The screen showed a title, a date and four GST rows over a total — the one thing it
          never said was WHAT the money was for. A buyer checking two tickets against their
          bank statement had to go and find the receipt.
        */}
        {(items.length > 0 || seats.length > 0) && (
          <div className="space-y-1.5 border-t border-border pt-3" data-testid="confirmation-order">
            <p className="text-caption font-medium uppercase tracking-wide text-text-muted">
              {c('yourOrder')}
            </p>
            {items.map((item, index) => (
              <div
                key={`${itemName(item)}-${index}`}
                className="flex justify-between gap-4 text-[0.9375rem]"
              >
                <span className="text-text-primary">
                  {c('itemLine', { name: itemName(item), quantity: item.quantity })}
                </span>
                <span className="tabular-nums text-text-secondary">
                  {free
                    ? tx('state.free')
                    : money(
                        item.unitPriceMinor * item.quantity,
                        booking.currency,
                        undefined,
                        itemDigits,
                      )}
                </span>
              </div>
            ))}
            {seats.length > 0 && (
              <div className="flex justify-between gap-4 text-[0.9375rem]">
                <span className="text-text-secondary">
                  {seats.length === 1 ? c('seat') : c('seats')}
                </span>
                <span className="text-right font-medium text-text-primary">{seats.join(', ')}</span>
              </div>
            )}
          </div>
        )}

        {/*
          The same breakdown the buyer agreed to on the payment screen — fees, the GST inside
          the ticket price, the GST on the fee — footing to what they paid.

          This used to print every tax line as a bare row above the total with no word about
          which were inside the price and which were added, so ₹38.06 + ₹38.06 + ₹1.82 + ₹1.82
          sat over ₹522.82 and did not add up to anything a buyer could check.
        */}
        {free ? (
          <div className="flex justify-between border-t border-border pt-3 text-[0.9375rem]">
            {/*
              "Total paid ₹0" reads as a payment that failed. Nothing was paid because nothing
              was owed, and those are different things to somebody checking their booking.
            */}
            <span className="text-text-secondary">{c('cost')}</span>
            <span className="font-semibold text-text-primary">{tx('state.free')}</span>
          </div>
        ) : (
          <PriceBreakdown
            quote={{
              currency: booking.currency,
              subtotalMinor: booking.subtotalMinor,
              discountMinor: booking.discountMinor,
              bookingFeeMinor: booking.bookingFeeMinor,
              paymentFeeMinor: booking.paymentFeeMinor,
              customerFeeInclusiveMinor: booking.customerFeeInclusiveMinor,
              customerFeeMinor: booking.customerFeeMinor,
              feeTaxRateBasisPoints: booking.feeTaxRateBasisPoints,
              feeTaxMinor: booking.feeTaxMinor,
              maintenanceMinor: booking.maintenanceMinor,
              maintenanceTreatment: booking.maintenanceTreatment,
              taxLines: booking.taxLines,
              totalMinor: booking.totalMinor,
            }}
            totalLabel={confirmed ? c('totalPaid') : undefined}
            note={null}
          />
        )}

        {receipt && (
          <button
            type="button"
            onClick={() => void api.openReceipt(receipt.id)}
            className="flex w-full items-center justify-between border-t border-border pt-3 text-left text-[0.9375rem] text-brand hover:underline"
          >
            <span className="inline-flex items-center gap-2">
              <ReceiptText className="h-4 w-4" />
              {d(`kind.${receipt.kind}`)} {receipt.number}
            </span>
            <span>{c('view')}</span>
          </button>
        )}
      </Card>

      {confirmed && (
        <>
          {/*
            The QR, right here. It is what the buyer came for and what the door scans. Each
            one opens that ticket on its own — full screen, brightness up, the way it is shown
            at the door — rather than making the buyer find it again in a list of every ticket
            they have ever bought.
          */}
          {tickets.length > 0 ? (
            <div className="space-y-3">
              {tickets.map((t) => (
                <Card key={t.id} className="flex items-center gap-4">
                  {/*
                    A vendor barcode the server cannot draw has no QR image. Say so in the
                    space the code would take, rather than an image with no source.
                  */}
                  {t.qrDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={t.qrDataUrl}
                      alt={c('ticketQrAlt', { serial: t.serial })}
                      className="h-28 w-28 shrink-0 rounded-md bg-white p-1"
                    />
                  ) : (
                    <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-background-subtle p-2 text-center text-caption text-text-muted">
                      {w('qrUnavailable')}
                    </div>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold text-text-primary">{booking.event.title}</p>
                    <p className="text-[0.9375rem] text-text-muted">
                      {dateTime(
                        booking.eventSession.startsAt,
                        undefined,
                        booking.timeZone ?? undefined,
                      )}
                    </p>
                    {t.seatLabel ? (
                      <p className="text-[0.9375rem] text-text-primary">
                        {c('seat')} <strong>{t.seatLabel}</strong>
                        {t.screenName ? ` · ${t.screenName}` : ''}
                      </p>
                    ) : null}
                    <p className="font-mono text-caption text-text-muted">{t.serial}</p>
                    <Link
                      href={`/account/tickets/${t.id}`}
                      className="inline-flex items-center gap-1 text-[0.9375rem] font-medium text-brand hover:underline"
                    >
                      {c('openTicket')}
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Link>
                  </div>
                </Card>
              ))}
              <p className="text-caption text-text-muted">
                {c('showAtDoor', { email: booking.buyerEmail })}
              </p>
            </div>
          ) : ticketsQ.isLoading ? (
            <div className="h-32 animate-pulse rounded-lg bg-background-subtle" />
          ) : null}

          {/*
            THIS booking's tickets first. The only way onward used to be "All my tickets" — a
            list of everything the account has ever bought, where the booking just made had to
            be found again.
          */}
          <div className="space-y-3">
            <ButtonLink href={`/account/bookings/${booking.id}/tickets`} className="w-full">
              <Ticket className="h-4 w-4" aria-hidden />
              {c('viewTickets')}
            </ButtonLink>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/account/tickets" className={SECONDARY_ACTION}>
                {c('allMyTickets')}
              </Link>
              <a href={ics} download={`${booking.event.slug}.ics`} className={SECONDARY_ACTION}>
                <CalendarPlus className="h-4 w-4" /> {tx('action.addToCalendar')}
              </a>
              <button onClick={share} className={SECONDARY_ACTION}>
                <Share2 className="h-4 w-4" /> {tx('action.share')}
              </button>
            </div>
          </div>

          {/*
            There used to be a star rating and a "Follow organizer" button here. Neither was
            connected to anything: the stars thanked the buyer and stored nothing, and the
            button promised "you'll hear about new events from this organizer" while nothing
            recorded the follow or would ever send that message. There is no follow API to
            wire it to, and the reviews API publishes a public review of the EVENT — not an
            answer to "how was booking?", and not something to post on somebody's behalf before
            they have attended. Reviews are written on the event page, where that is clear.
          */}
        </>
      )}

      {/* Recommendations */}
      {upcoming.data && upcoming.data.data.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-title font-semibold text-text-primary">{e('recommendations')}</h2>
          <div className="grid gap-4">
            {upcoming.data.data.slice(0, 2).map((ev) => (
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
