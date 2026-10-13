'use client';

import { useQuery } from '@tanstack/react-query';
import { ReferenceCode } from '@/components/reference-code';
import { useParams } from 'next/navigation';
import {
  CalendarPlus,
  Check,
  ChevronRight,
  Clock,
  ReceiptText,
  Share2,
  Ticket,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  BRAND_FOCUS,
  BrandStatusPill,
  brandButtonClasses,
  buildIcsDataUrl,
  useToast,
  type BookingDetail,
  type BrandStatus,
} from '@eticketsgo/web-kit';
import type { Locale } from '@eticketsgo/i18n';
import { api, tokenStore } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Link, getPathname } from '@/i18n/navigation';
import { EventCard } from '@/components/event-card';
import { PriceBreakdown } from '@/components/price-breakdown';
import { ErrorState } from '@/components/ui';
import {
  BRAND_EYEBROW,
  BRAND_LINK,
  BRAND_PANEL,
  BrandSteps,
  useVenueWhenText,
} from '@/components/booking-brand';
import { useStatusLabel } from '@/lib/status-label';
import {
  GuestBookingNotHere,
  GuestBookingSummary,
  GuestTickets,
} from '@/components/guest-booking-view';
import { GuestClaimCard } from '@/components/guest-self-service';
import { guestTokenFor } from '@/lib/guest-session';
import { useMounted } from '@/lib/use-mounted';
import { useLocale, useTranslations } from 'next-intl';
import { siteUrl } from '@/lib/site-url';

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

/** A booking's status as a brand pill: words always, colour only for what happened. */
const STATUS_TONE: Record<string, BrandStatus> = {
  CONFIRMED: 'positive',
  PENDING_PAYMENT: 'info',
  REFUNDED: 'info',
  PARTIALLY_REFUNDED: 'info',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

/** The confirmation on the brand layer, out to the page column's edges like the rest of the flow. */
function ConfirmShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-brand="customer"
      className="-mx-4 -mt-6 min-h-[60vh] bg-brand-canvas px-4 pb-16 pt-6 font-brand-text text-brand-ink sm:-mx-6 sm:-mt-10 sm:px-6 sm:pt-10 lg:-mx-8 lg:px-10"
    >
      <div className="mx-auto max-w-5xl space-y-8">{children}</div>
    </div>
  );
}

/**
 * The answer to "did it work?", as large as the page allows: a mark that says the state by
 * shape (a tick, a cross, a clock), the headline in the display face, one sentence under it.
 */
function ConfirmHeadline({
  state,
  title,
  body,
}: {
  state: 'confirmed' | 'closed' | 'pending';
  title: string;
  body: string;
}) {
  const Icon = state === 'confirmed' ? Check : state === 'closed' ? XCircle : Clock;
  return (
    <div className="flex items-start gap-4">
      <span
        aria-hidden
        className={`flex h-14 w-14 shrink-0 animate-scale-in items-center justify-center rounded-full ${
          state === 'confirmed'
            ? 'bg-brand-positive-tint text-brand-positive'
            : state === 'closed'
              ? 'bg-brand-sunken text-brand-ink-3'
              : 'bg-brand-info-tint text-brand-info'
        }`}
      >
        <Icon className="h-7 w-7" strokeWidth={2.5} />
      </span>
      <div className="min-w-0">
        {/* The mark beside it already says this went well; an emoji here was one more glyph to fail. */}
        <h1 className="font-brand-display text-brand-d1 text-brand-ink">{title}</h1>
        <p className="mt-2 max-w-prose text-brand-body text-brand-ink-2">{body}</p>
      </div>
    </div>
  );
}

/**
 * Where a booking lands, with or without an account.
 *
 * The fork is the same one the payment screen makes, for the same reason: a guest reads a
 * different endpoint and gets a different payload. See PaymentPage.
 */
export default function ConfirmationPage() {
  const mounted = useMounted();
  const { id } = useParams<{ id: string }>();
  const guestToken = mounted ? guestTokenFor(id) : null;

  if (!mounted) return <div className="h-64 animate-pulse rounded-lg bg-background-subtle" />;
  if (guestToken) return <GuestConfirmation id={id} anonSession={guestToken} />;
  // Signed out with no guest token: the account read can only 401, so say what to do instead.
  if (!tokenStore.access) return <GuestBookingNotHere bookingId={id} />;
  return <AccountConfirmation />;
}

function AccountConfirmation() {
  const c = useTranslations('storefront.confirmation');
  const e = useTranslations('storefront.event');
  const w = useTranslations('storefront.wallet');
  const d = useTranslations('documents');
  const tx = useTranslations('common');
  // The badge in the reader's language: French showed "PENDING PAYMENT" here on QA.
  const statusLabel = useStatusLabel();
  const locale = useLocale() as Locale;
  const { money, moneyFractionDigits } = useFormat();
  const venueWhenText = useVenueWhenText();
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
  /*
    ── THE EVENT THEY JUST BOUGHT WAS BEING RECOMMENDED TO THEM ───────────────────────
    This asked for the next three events on the platform and printed the first two under
    "You might also like". Nothing excluded the booking - so somebody who had just paid for
    Standup Night was shown Standup Night, as a suggestion, on the receipt for it. Observed
    on a real purchase.

    Two things were wrong and the filter only fixes one. `listEvents` is the catalogue in date
    order: it was never a recommendation, just whatever is on next. The recommendations
    endpoint the event page already uses ranks them, so this now asks the same question the
    rest of the product asks.

    Five are fetched to show two, because the filter can remove one and an empty row under a
    heading reads as something that failed to load.
  */
  const upcoming = useQuery({
    queryKey: ['recommendations', 'confirmation'],
    queryFn: () => api.recommendations({ limit: 5 }),
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
  // In seat order (E13 before E14), the order the summary and Review & pay list the seats.
  const tickets = (ticketsQ.data ?? [])
    .filter((t) => t.bookingId === id)
    .sort((a, b) =>
      (a.seatLabel ?? '').localeCompare(b.seatLabel ?? '', undefined, { numeric: true }),
    );
  const seats = booking.seatLabels ?? [];
  const items = booking.items.filter((item) => item.quantity > 0);
  // One number of decimals for the order lines, so ₹499 does not sit above ₹10.18.
  const itemDigits = moneyFractionDigits(
    [...items.map((item) => item.unitPriceMinor * item.quantity), booking.totalMinor],
    booking.currency,
  );
  /*
    When and where, as the venue reads them.

    The time is the venue's clock with the zone written next to it ("IST", "MDT"): a buyer
    reading this in another zone, or forwarding it, must not have to guess whose 7:30 it is.
    The place is the building - the confirmation named a seat and a screen and never which
    cinema, which is the one thing somebody with two bookings in one city needs.
  */
  const zone = booking.timeZone ?? undefined;
  const when = venueWhenText(booking.eventSession.startsAt, zone);
  const where = booking.place
    ? [booking.place.name, booking.place.city].filter(Boolean).join(', ')
    : null;

  const ics = buildIcsDataUrl({
    title: booking.event.title,
    description: c('icsDescription'),
    start: booking.eventSession.startsAt,
  });

  /*
    Anything but the event they just bought.

    Matched on the slug because that is the identifier a booking carries - `BookingDetail.event`
    has a title and a slug and no id. The slug is unique per event, so it answers the question
    exactly; the title would not, since two organizers may run an event of the same name.
  */
  const suggestions = (upcoming.data ?? [])
    .filter((ev) => ev.slug !== booking.event.slug)
    .slice(0, 2);

  const share = async () => {
    // In the reader's language: a French buyer sharing with a French friend should send the
    // French page, and the default locale has no prefix to add.
    const url = siteUrl(getPathname({ href: `/events/${booking.event.slug}`, locale }));
    if (navigator.share)
      await navigator.share({ title: booking.event.title, url }).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      toast.push(c('linkCopied'), 'success');
    }
  };

  return (
    <ConfirmShell>
      <BrandSteps
        steps={(free ? FREE_BOOKING_STEPS : BOOKING_STEPS).map((k) => c(`steps.${k}`))}
        current={free ? 1 : confirmed ? 2 : 1}
      />

      <ConfirmHeadline
        state={confirmed ? 'confirmed' : closed ? 'closed' : 'pending'}
        title={confirmed ? c('youreGoing') : closed ? c(closedCopy.title) : c('pending')}
        body={
          confirmed
            ? c('sentTo', { count: booking.tickets.length, email: booking.buyerEmail })
            : closed
              ? c(closedCopy.body)
              : c('pendingBody')
        }
      />

      {/* A way forward from every state that is not the one the buyer hoped for. */}
      {pending && (
        <Link
          href={holdLive ? `/booking/${booking.id}/payment` : `/events/${booking.event.slug}`}
          className={`${brandButtonClasses('secondary', 'lg')} w-full sm:w-auto`}
        >
          {holdLive ? c('returnToPayment') : c('backToEvent')}
        </Link>
      )}
      {closed && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href={`/events/${booking.event.slug}`}
            className={`${brandButtonClasses('primary', 'lg')} w-full sm:w-auto`}
          >
            {c('backToEvent')}
          </Link>
          <Link
            href="/account/bookings"
            className={`${brandButtonClasses('secondary', 'lg')} w-full sm:w-auto`}
          >
            {c('myBookings')}
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
        <div className="min-w-0 space-y-6">
          {confirmed && (
            <>
              {/*
                The QR, right here. It is what the buyer came for and what the door scans. Each
                one opens that ticket on its own — full screen, brightness up, the way it is shown
                at the door — rather than making the buyer find it again in a list of every ticket
                they have ever bought.
              */}
              {tickets.length > 0 ? (
                <section aria-labelledby="tickets-heading" className="space-y-3">
                  <h2 id="tickets-heading" className={BRAND_EYEBROW}>
                    {c('steps.ticket')}
                  </h2>
                  <ul className="space-y-3">
                    {tickets.map((t) => (
                      <li key={t.id} className={`${BRAND_PANEL} flex items-center gap-4 p-4`}>
                        {/*
                          A vendor barcode the server cannot draw has no QR image. Say so in the
                          space the code would take, rather than an image with no source.
                        */}
                        {t.qrDataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={t.qrDataUrl}
                            alt={c('ticketQrAlt', { serial: t.serial })}
                            className="h-28 w-28 shrink-0 rounded-brand-control bg-white p-1"
                          />
                        ) : (
                          <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-brand-control border border-dashed border-brand-line-strong bg-brand-sunken p-2 text-center text-brand-meta text-brand-ink-3">
                            {w('qrUnavailable')}
                          </div>
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="font-brand-display text-brand-card text-brand-ink">
                            {booking.event.title}
                          </p>
                          <p className="text-brand-meta text-brand-ink-2">{when}</p>
                          {t.seatLabel ? (
                            <p className="text-brand-ui text-brand-ink">
                              {c('seat')} <strong className="font-semibold">{t.seatLabel}</strong>
                              {t.screenName ? ` - ${t.screenName}` : ''}
                            </p>
                          ) : null}
                          {where ? (
                            <p className="text-brand-meta text-brand-ink-2">{where}</p>
                          ) : null}
                          <p className="font-mono text-brand-meta text-brand-ink-3">{t.serial}</p>
                          <Link
                            href={`/account/tickets/${t.id}`}
                            className={`inline-flex min-h-11 items-center gap-1 text-brand-ui ${BRAND_LINK}`}
                          >
                            {c('openTicket')}
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="text-brand-meta text-brand-ink-3">
                    {c('showAtDoor', { email: booking.buyerEmail })}
                  </p>
                </section>
              ) : ticketsQ.isLoading ? (
                <div className="h-32 animate-pulse rounded-brand-card bg-brand-sunken" />
              ) : null}

              {/*
                THIS booking's tickets first. The only way onward used to be "All my tickets" — a
                list of everything the account has ever bought, where the booking just made had to
                be found again.
              */}
              <div className="space-y-3">
                <Link
                  href={`/account/bookings/${booking.id}/tickets`}
                  className={`${brandButtonClasses('primary', 'lg')} w-full`}
                >
                  <Ticket className="h-4 w-4" aria-hidden />
                  {c('viewTickets')}
                </Link>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="/account/tickets"
                    className={`${brandButtonClasses('secondary', 'md')} w-full sm:w-auto sm:flex-1`}
                  >
                    {c('allMyTickets')}
                  </Link>
                  <a
                    href={ics}
                    download={`${booking.event.slug}.ics`}
                    className={`${brandButtonClasses('secondary', 'md')} w-full sm:w-auto sm:flex-1`}
                  >
                    <CalendarPlus className="h-4 w-4" aria-hidden /> {tx('action.addToCalendar')}
                  </a>
                  <button
                    type="button"
                    onClick={share}
                    className={`${brandButtonClasses('secondary', 'md')} w-full sm:w-auto sm:flex-1`}
                  >
                    <Share2 className="h-4 w-4" aria-hidden /> {tx('action.share')}
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
        </div>

        {/* The order: what, when, where, the reference, and what it cost. */}
        <section
          aria-labelledby="order-summary-heading"
          className={`${BRAND_PANEL} space-y-4 p-4 sm:p-6 lg:col-start-2 lg:row-start-1 lg:self-start`}
        >
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-3">
              <h2
                id="order-summary-heading"
                className="font-brand-display text-brand-d3 text-brand-ink"
              >
                {booking.event.title}
              </h2>
              <BrandStatusPill status={STATUS_TONE[booking.status] ?? 'neutral'}>
                {statusLabel('booking', booking.status)}
              </BrandStatusPill>
            </div>
            <p className="text-brand-ui text-brand-ink-2" data-testid="confirmation-when">
              {when}
            </p>
            {where ? (
              <p className="text-brand-ui text-brand-ink-2" data-testid="confirmation-where">
                {where}
              </p>
            ) : null}
          </div>

          {booking.reference && (
            <div className="flex items-center justify-between gap-3 border-t border-brand-line pt-4 text-brand-ui">
              <span className="text-brand-ink-2">{c('bookingReference')}</span>
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
            <div
              className="space-y-2 border-t border-brand-line pt-4"
              data-testid="confirmation-order"
            >
              <p className={BRAND_EYEBROW}>{c('yourOrder')}</p>
              {items.map((item, index) => (
                <div
                  key={`${itemName(item)}-${index}`}
                  className="flex justify-between gap-4 text-brand-ui"
                >
                  <span className="text-brand-ink">
                    {c('itemLine', { name: itemName(item), quantity: item.quantity })}
                  </span>
                  <span className="tabular-nums text-brand-ink-2">
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
                <div className="flex justify-between gap-4 text-brand-ui">
                  <span className="text-brand-ink-2">
                    {seats.length === 1 ? c('seat') : c('seats')}
                  </span>
                  <span className="text-right font-semibold text-brand-ink">
                    {seats.join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}

          {/*
            The same breakdown the buyer agreed to on the payment screen — fees, the GST inside
            the ticket price, the GST on the fee — footing to what they paid.
          */}
          {free ? (
            <div className="flex justify-between border-t border-brand-line pt-4 text-brand-ui">
              {/*
                "Total paid Rs 0" reads as a payment that failed. Nothing was paid because nothing
                was owed, and those are different things to somebody checking their booking.
              */}
              <span className="text-brand-ink-2">{c('cost')}</span>
              <span className="font-semibold text-brand-ink">{tx('state.free')}</span>
            </div>
          ) : (
            <PriceBreakdown
              brand
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
              className={`flex min-h-11 w-full items-center justify-between gap-3 border-t border-brand-line pt-4 text-left text-brand-ui text-brand-ink hover:underline ${BRAND_FOCUS}`}
            >
              <span className="inline-flex items-center gap-2">
                <ReceiptText className="h-4 w-4 text-brand-ink-3" aria-hidden />
                {d(`kind.${receipt.kind}`)} {receipt.number}
              </span>
              <span className="font-semibold">{c('view')}</span>
            </button>
          )}
        </section>
      </div>

      {/* Recommendations */}
      {suggestions.length > 0 && (
        <section className="space-y-4 pt-6">
          <h2 className="font-brand-display text-brand-d2 text-brand-ink">
            {e('recommendations')}
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {suggestions.map((ev) => (
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
        </section>
      )}
    </ConfirmShell>
  );
}

/**
 * A guest booking, just paid for.
 *
 * ── WHY IT STILL POLLS ─────────────────────────────────────────────────────────────
 * For the same reason the account screen does. Confirmation arrives on a signed webhook from
 * the payment provider, not from the browser that paid, so the only honest thing a page can do
 * between "paid" and "confirmed" is keep asking. Every other status is final and the polling
 * stops -- an expired hold will not change however long the page waits.
 *
 * ── WHERE THE QR COMES FROM ────────────────────────────────────────────────────────
 * The booking payload, not the wallet. `api.wallet()` answers for an account and there is no
 * account here.
 */
function GuestConfirmation({ id, anonSession }: { id: string; anonSession: string }) {
  const c = useTranslations('storefront.confirmation');
  const g = useTranslations('storefront.guest');

  const {
    data: view,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['guest-booking', id],
    queryFn: () => api.getGuestBooking(id, anonSession),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === AWAITING_PAYMENT ? 4000 : false;
    },
  });

  if (isError) return <ErrorState message={c('loadError')} onRetry={() => refetch()} />;
  if (isLoading || !view)
    return <div className="h-64 animate-pulse rounded-lg bg-background-subtle" />;

  const confirmed = view.status === 'CONFIRMED';
  const pending = view.status === AWAITING_PAYMENT;
  const closed = !confirmed && !pending;
  const closedCopy = CLOSED_COPY[view.status as keyof typeof CLOSED_COPY] ?? CLOSED_FALLBACK;
  // Read from this booking's own total: nothing was owed, so nothing was paid.
  const free = view.totals.totalMinor === 0;
  /*
    A booking with no hold expiry has nothing left to hold: it is already paid for, or it was
    never holding stock. Treating a missing deadline as "still live" would offer a way back to
    a payment page that can only turn the buyer away.
  */
  const holdLive =
    pending && !!view.holdExpiresAt && new Date(view.holdExpiresAt).getTime() > Date.now();

  return (
    <ConfirmShell>
      <BrandSteps
        steps={(free ? FREE_BOOKING_STEPS : BOOKING_STEPS).map((k) => c(`steps.${k}`))}
        current={free ? 1 : confirmed ? 2 : 1}
      />

      <ConfirmHeadline
        state={confirmed ? 'confirmed' : closed ? 'closed' : 'pending'}
        title={confirmed ? c('youreGoing') : closed ? c(closedCopy.title) : c('pending')}
        body={
          confirmed
            ? c('sentTo', { count: view.tickets.length, email: view.buyer.emailMasked })
            : closed
              ? c(closedCopy.body)
              : c('pendingBody')
        }
      />

      {pending && (
        <Link
          href={holdLive ? `/booking/${view.id}/payment` : `/events/${view.event.slug}`}
          className={`${brandButtonClasses('secondary', 'lg')} w-full sm:w-auto`}
        >
          {holdLive ? c('returnToPayment') : c('backToEvent')}
        </Link>
      )}
      {closed && (
        <Link
          href={`/events/${view.event.slug}`}
          className={`${brandButtonClasses('primary', 'lg')} w-full sm:w-auto`}
        >
          {c('backToEvent')}
        </Link>
      )}

      {/*
        The guest summary and tickets are shared with the emailed booking link
        (/booking/access), which has not moved to the brand layer yet; they keep their own cards
        here until that page does, so the two never drift apart.
      */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
        <div className="min-w-0 space-y-6">
          {confirmed && (
            <>
              <GuestTickets view={view} printHref={`/booking/${view.id}/tickets/print`} />
              {/*
                The one thing a guest needs that an account holder does not: a way back to this
                page from a different device, or after this browser forgets the booking.
              */}
              <section className={`${BRAND_PANEL} space-y-2 p-4 sm:p-6`}>
                <h2 className="font-brand-display text-brand-card text-brand-ink">
                  {g('keepTicketsTitle')}
                </h2>
                <p className="text-brand-ui text-brand-ink-2">
                  {g('keepTicketsBody', { email: view.buyer.emailMasked })}
                </p>
                <p className="text-brand-meta text-brand-ink-3">
                  {g('wantAnAccount')}{' '}
                  <Link href="/register" className={BRAND_LINK}>
                    {g('createAccountLater')}
                  </Link>
                </p>
              </section>
              {/*
                The offer to keep the booking, here as well as on the emailed link.

                This is the moment a buyer is most likely to take it: they have just paid, the
                tickets are in front of them, and they have not yet closed the tab. The claim is
                proved by the anonymous session this browser is holding -- the same token that read
                the booking to draw this page -- so no access token is needed and none exists here.
              */}
              <GuestClaimCard bookingId={view.id} anonSession={anonSession} />
            </>
          )}
        </div>
        <div className="lg:col-start-2 lg:row-start-1">
          <GuestBookingSummary view={view} />
        </div>
      </div>
    </ConfirmShell>
  );
}
