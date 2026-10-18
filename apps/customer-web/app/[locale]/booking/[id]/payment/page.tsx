'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Clock, QrCode, RefreshCcw, ShieldCheck } from 'lucide-react';
import { BrandButton, api as webKit, brandButtonClasses } from '@eticketsgo/web-kit';
import { razorpayFailureReason } from '@eticketsgo/shared-types';
import { api, ApiRequestError, tokenStore } from '@/lib/api';
import { loadRazorpay } from '@/lib/razorpay';
import { useFormat } from '@/lib/format';
import { bookingAmounts } from '@/lib/booking-amounts';
import { Dialog, useToast } from '@/components/ui';
import {
  BrandActionButton,
  BrandLoadError,
  BrandSkeleton,
  BrandStatePage,
} from '@/components/brand-forms';
import {
  BRAND_EYEBROW,
  BRAND_FIELD,
  BRAND_LINK,
  BRAND_PANEL,
  BrandSteps,
  useVenueWhenText,
} from '@/components/booking-brand';
import { paymentsActivatingCopy } from '@/components/payment/payments-activating';
import { PriceBreakdown } from '@/components/price-breakdown';
import { RefundTerms } from '@/components/refund-terms';
import { GuestBookingNotHere, GuestBookingSummary } from '@/components/guest-booking-view';
import {
  forgetGuestBooking,
  guestTokenFor,
  rememberCancelledGuestBooking,
} from '@/lib/guest-session';
import { useMounted } from '@/lib/use-mounted';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

// The same step names as the confirmation screen, from the same messages.
const BOOKING_STEPS = ['tickets', 'payment', 'confirmation', 'ticket'] as const;

/**
 * True only for an absolute http(s) URL on a *different* host than this app —
 * i.e. a real hosted Stripe Checkout page. The local/dev mock returns a
 * same-origin relative path, which resolves to our own host and is NOT external.
 */
function isExternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.host !== window.location.host
    );
  } catch {
    return false;
  }
}

/** Live mm:ss countdown to the hold expiry. */
function useCountdown(expiresAt: string | undefined) {
  const [remaining, setRemaining] = useState<number>(() =>
    expiresAt ? Math.max(0, new Date(expiresAt).getTime() - Date.now()) : 0,
  );
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemaining(Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  const totalSeconds = Math.floor(remaining / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return { expired: remaining <= 0, label: `${mm}:${ss}`, totalSeconds };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-brand-ui">
      <span className="text-brand-ink-2">{label}</span>
      <span className="tabular-nums text-brand-ink">{value}</span>
    </div>
  );
}

/**
 * Review & pay on the brand layer (docs/design/DESIGN-SYSTEM.md): paper, ink, one primary
 * action. Out to the page column's edges like the event page, with its own gutters, so the
 * flow from event to payment reads as one place.
 */
function PayShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-brand="customer"
      className="-mx-4 -mt-6 min-h-[60vh] bg-brand-canvas px-4 pb-16 pt-6 font-brand-text text-brand-ink sm:-mx-6 sm:-mt-10 sm:px-6 sm:pt-10 lg:-mx-8 lg:px-10"
    >
      <div className="mx-auto max-w-5xl space-y-6">{children}</div>
    </div>
  );
}

function PayHeader({ title, steps, lead }: { title: string; steps: string[]; lead?: string }) {
  return (
    <div className="space-y-3">
      <BrandSteps steps={steps} current={1} />
      <h1 className="font-brand-display text-brand-d1 text-brand-ink">{title}</h1>
      {lead ? <p className="text-brand-ui text-brand-ink-2">{lead}</p> : null}
    </div>
  );
}

/**
 * The hold, counted down. Quiet while there is time, caution under two minutes, critical when
 * it has run out - and always in words, so the state never rests on colour.
 */
function HoldTimer({ countdown }: { countdown: ReturnType<typeof useCountdown> }) {
  const k = useTranslations('storefront.checkout');
  const expired = countdown.expired;
  const short = !expired && countdown.totalSeconds < 120;
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-brand-card px-4 py-3 ${
        expired ? 'bg-brand-critical-tint' : short ? 'bg-brand-caution-tint' : 'bg-brand-sunken'
      }`}
    >
      <span
        className={`flex items-center gap-2 text-brand-ui ${
          expired ? 'text-brand-critical' : 'text-brand-ink-2'
        }`}
      >
        <Clock className="h-4 w-4" aria-hidden />
        {expired ? k('holdExpiredTitle') : k('ticketsHeldForYou')}
      </span>
      {!expired && (
        <span
          className={`text-brand-figure-sm tabular-nums ${short ? 'text-brand-caution' : 'text-brand-ink'}`}
          aria-live="polite"
        >
          {countdown.label}
        </span>
      )}
    </div>
  );
}

/**
 * Paying for a booking, with or without an account.
 *
 * ── WHY THE FORK IS HERE AND NOT INSIDE ONE COMPONENT ──────────────────────────────
 * The two paths read different endpoints and get different payloads: an account gets the
 * fee-by-fee booking, a guest gets the four totals a guest is allowed to see. One component
 * serving both would branch on every line that touches the booking, and the branch it got
 * wrong would be the one that charges somebody. Two components, one decision, taken once.
 *
 * The decision is "does this browser hold a guest token for this booking id", not "is anybody
 * signed in". Somebody who bought as a guest and then signed in still owns a guest booking:
 * their account cannot read it, and the token can.
 */
export default function PaymentPage() {
  const mounted = useMounted();
  const { id } = useParams<{ id: string }>();
  // localStorage does not exist while the server renders, so this is read after mounting.
  const guestToken = mounted ? guestTokenFor(id) : null;

  if (!mounted)
    return (
      <BrandStatePage>
        <BrandSkeleton className="h-72 w-full" />
      </BrandStatePage>
    );
  if (guestToken) return <GuestPayment id={id} anonSession={guestToken} />;
  if (!tokenStore.access) return <GuestBookingNotHere bookingId={id} />;
  return <AccountPayment />;
}

function AccountPayment() {
  const k = useTranslations('storefront.checkout');
  const c = useTranslations('storefront.confirmation');
  const tx = useTranslations('common');
  const { money, moneyFractionDigits } = useFormat();
  const venueWhenText = useVenueWhenText();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /*
    Payments not being available yet is STATE, not an error message - the same distinction the
    cancel button below already makes.

    A red "Payment failed" would be a lie: nothing was attempted, nothing was declined, and there
    is nothing the buyer can do differently. The platform is waiting on its payment gateway, which
    is a fact about us and is worth saying plainly to whoever is standing at the payment step -
    including the gateway's own reviewer, who will be.
  */
  const [paymentsActivating, setPaymentsActivating] = useState(false);
  const [code, setCode] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);

  /*
    Re-prices the booking. `null` clears the code.

    An invalid code is surfaced rather than swallowed: a box that accepts anything and
    changes nothing is worse than one that says no. The server refuses outright once payment
    has started with the provider, because a total and a gateway amount that disagree is the
    outcome worth failing loudly to avoid.
  */
  const coupon = useMutation({
    mutationFn: (next: string | null) => api.setBookingCoupon(id, next),
    onSuccess: (_r, next) => {
      setCouponError(null);
      if (next === null) setCode('');
      qc.invalidateQueries({ queryKey: ['booking', id] });
    },
    onError: (e: unknown) => setCouponError(e instanceof Error ? e.message : k('codeRejected')),
  });

  const {
    data: booking,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
  });

  /*
    Extending re-reads the booking rather than patching the countdown locally: the server
    decides the new deadline, and a client that guessed it would drift from the value the
    payment guard actually enforces.
  */
  const extendHold = useMutation({
    mutationFn: () => api.extendBookingHold(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['booking', id] });
      setError(null);
    },
    onError: () => setError(k('extendFailed')),
  });

  /*
    Letting go of the seats on purpose.

    Without this the only way out of a hold was to close the tab and wait for the timer —
    minutes in which nobody else could buy those seats, and in which the buyer's bookings still
    said "pending payment" for something they had decided against. The server cancels only an
    unpaid booking and releases its hold exactly once; a booking paid or expired meanwhile is
    refused, and re-reading it puts the right screen in front of the buyer.
  */
  const toast = useToast();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancelBooking = useMutation({
    mutationFn: () => webKit.bookings.cancel(id),
    onSuccess: () => {
      setConfirmingCancel(false);
      qc.invalidateQueries({ queryKey: ['booking', id] });
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast.push(k('bookingCancelled'), 'success');
      router.push('/account/bookings');
    },
    onError: () => {
      setConfirmingCancel(false);
      setError(k('cancelFailed'));
      qc.invalidateQueries({ queryKey: ['booking', id] });
    },
  });

  /*
    The offers this session actually advertises.

    The discount box has been here since somebody reported that an organizer made a
    promotion and had nowhere to use it — but it is a blank field, so it only helps a buyer
    who already knows the code. The organizer's promotion existed, the API would honour it,
    and nothing on the screen said it was there. On QA that is a live `FIRST10 — 10% off`
    that nobody buying a ticket could discover.

    The seat-picking screen has listed these for a while. This is the same list on the
    screen where the discount box lives, which is where most buyers actually reach it —
    general-admission events never pass through a seat map at all.

    Private codes are never listed; `GET /bookings/offers/:id` returns only what the
    organizer chose to advertise.
  */
  const offersQ = useQuery({
    queryKey: ['offers', booking?.eventSession?.id],
    queryFn: () => api.sessionOffers(booking!.eventSession!.id),
    enabled: Boolean(booking?.eventSession?.id) && (booking?.discountMinor ?? 0) === 0,
    staleTime: 300_000,
  });

  const countdown = useCountdown(booking?.holdExpiresAt);

  const pay = useMutation({
    mutationFn: async () => {
      const payResult = await api.payBooking(id);
      const { clientActionUrl } = payResult;
      if (isExternalUrl(clientActionUrl)) {
        // Real Stripe: hand off to the hosted Checkout page. Confirmation happens
        // only via the signed webhook after Stripe processes the payment — landing
        // back on our success_url is NEVER treated as proof of payment.
        window.location.href = clientActionUrl;
        return { redirected: true as const };
      }
      // India (Razorpay): open Standard Checkout in a modal. The Checkout handler
      // and signature verification are NEVER treated as proof of payment — the
      // signed webhook confirms the booking, which the confirmation page polls for.
      if (payResult.provider === 'razorpay' && payResult.razorpay) {
        const rzp = payResult.razorpay;
        const Razorpay = await loadRazorpay();
        /*
          Whether this Checkout session saw a refusal. Closing the window after one is not a
          cancellation, and the reason must not be overwritten by "Payment was cancelled".
        */
        let failed = false;
        const checkout = new Razorpay({
          key: rzp.keyId,
          order_id: rzp.orderId,
          amount: rzp.amountMinor,
          currency: rzp.currency,
          name: rzp.name,
          description: rzp.description,
          prefill: rzp.prefill,
          /*
            "Pay by any UPI App" first — a scannable QR on desktop, the installed UPI apps on
            mobile — with cards, netbanking and wallets still listed below it.

            Only when the API says the Razorpay account has UPI switched on. Pinning a UPI
            block on an account without UPI gives the buyer an empty first option, so without
            that answer no `config` is passed and Checkout shows its default list, as before.
          */
          ...(rzp.upiEnabled
            ? {
                config: {
                  display: {
                    blocks: {
                      upi: {
                        name: k('upiBlockName'),
                        instruments: [{ method: 'upi', flows: ['qr', 'intent'] }],
                      },
                    },
                    sequence: ['block.upi'],
                    preferences: { show_default_blocks: true },
                  },
                },
              }
            : {}),
          handler: (resp) => {
            void (async () => {
              try {
                await api.razorpayVerify(id, {
                  razorpay_order_id: resp.razorpay_order_id,
                  razorpay_payment_id: resp.razorpay_payment_id,
                  razorpay_signature: resp.razorpay_signature,
                });
                // Verified signature only — the confirmation page keeps polling
                // until the signed webhook actually confirms the booking.
                qc.invalidateQueries({ queryKey: ['booking', id] });
                router.push(`/booking/${id}/confirmation`);
              } catch {
                setError(k('verifyFailed'));
              }
            })();
          },
          modal: {
            ondismiss: () => {
              if (!failed) setError(k('paymentCancelled'));
            },
          },
        });
        /*
          Why the payment was refused, in words the buyer can act on.

          Without this listener every refusal surfaced as "Payment was cancelled" once the
          window closed. On QA that hid Razorpay's actual answer — the account takes Indian
          cards only — and buyers retried the same international test card again and again.
        */
        checkout.on('payment.failed', (response) => {
          failed = true;
          setError(k(`failure.${razorpayFailureReason(response.error)}`));
        });
        checkout.open();
        return { redirected: true as const };
      }
      // Local/dev mock (same-origin URL, no hosted page): stand in with mock-pay.
      // A real gateway would instead call our signed webhook.
      await api.mockPay(id, 'succeeded');
      return { redirected: false as const };
    },
    onSuccess: (result) => {
      if (result.redirected) return; // Navigating away to Stripe — keep the button busy.
      qc.invalidateQueries({ queryKey: ['booking', id] });
      router.push(`/booking/${id}/confirmation`);
    },
    onError: (err: unknown) => {
      /*
        PAYMENT_PROVIDER_UNAVAILABLE means no gateway can take this currency at all - the
        platform has no credentials for it yet. That is not a failed payment and must not be
        dressed as one; it is answered with the notice below instead.
      */
      if (err instanceof ApiRequestError && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE') {
        setPaymentsActivating(true);
        setError(null);
        return;
      }
      // The API returns 402 for a declined/insufficient-funds payment — tell the
      // buyer specifically so they can try another method (see all-exceptions.filter).
      const status = (err as { status?: number }).status;
      setError(status === 402 ? k('failure.CARD_DECLINED') : k('paymentFailed'));
    },
  });

  if (isError)
    return (
      <BrandStatePage>
        <BrandLoadError message={k('loadError')} onRetry={() => refetch()} />
      </BrandStatePage>
    );
  if (isLoading || !booking)
    return (
      <BrandStatePage>
        <BrandSkeleton className="h-72 w-full" />
      </BrandStatePage>
    );

  if (booking.status !== 'PENDING_PAYMENT') {
    // The status in the reader's language where the catalogue names it; a status it does
    // not know yet is still shown, spelled out, rather than hidden.
    const statusKey = `status.${booking.status}`;
    const statusLabel = tx.has(statusKey)
      ? tx(statusKey)
      : booking.status.replaceAll('_', ' ').toLowerCase();
    return (
      <PayShell>
        <div className={`${BRAND_PANEL} mx-auto max-w-md p-6 text-center`}>
          <p className="text-brand-body text-brand-ink">
            {k('bookingStatus', { status: statusLabel })}
          </p>
          <BrandButton className="mt-4" onClick={() => router.push(`/booking/${id}/confirmation`)}>
            {k('viewBooking')}
          </BrandButton>
        </div>
      </PayShell>
    );
  }

  const expired = countdown.expired;
  /*
    One decision about decimals for everything this screen prints, so "2 x Classic" and the
    breakdown under it show one figure one way (Rs 500.00 twice, not Rs 500 above Rs 500.00).
    Every amount the breakdown draws goes into the decision, as on the event page.
  */
  const digits = moneyFractionDigits(bookingAmounts(booking), booking.currency);
  // The building, as the seat page and the confirmation name it.
  const where = booking.place
    ? [booking.place.name, booking.place.city].filter(Boolean).join(', ')
    : null;

  return (
    <PayShell>
      <PayHeader title={k('reviewAndPay')} steps={BOOKING_STEPS.map((s) => c(`steps.${s}`))} />
      <HoldTimer countdown={countdown} />

      {/*
        More time, for anybody who needs it.

        ── WHY THIS IS HERE AT ALL ─────────────────────────────────────────────────────
        WCAG 2.2.1 (Timing Adjustable) is a Level A criterion and a countdown with no way to
        stop it is a plain failure of it. For most people the timer is an inconvenience; for
        somebody reading with a screen reader, typing one-handed, or translating the page as
        they go, it is the difference between being able to buy a ticket and not.

        The criterion asks for a WARNING before the limit expires and a SIMPLE ACTION to
        extend. So the offer appears at two minutes — not from the start, where it would read
        as an invitation to dawdle — and it is one button that takes no input.

        `role="alert"` rather than a polite region: this is the point at which somebody is
        about to lose their seats, and it should interrupt.
      */}
      {!expired && countdown.totalSeconds < 120 && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-brand-card bg-brand-caution-tint px-4 py-3"
        >
          <span className="text-brand-ui text-brand-ink">
            {extendHold.data?.extensionsRemaining === 0
              ? k('noMoreExtensions')
              : `${k('expiringSoon')} ${k('needMoreTime')}`}
          </span>
          {extendHold.data?.extensionsRemaining !== 0 && (
            <BrandButton
              variant="secondary"
              aria-busy={extendHold.isPending || undefined}
              disabled={extendHold.isPending}
              onClick={() => extendHold.mutate()}
            >
              {extendHold.isPending ? k('extending') : k('keepMySeats')}
            </BrandButton>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
        {/* What is being bought: the show, the seats, the lines, and a place for a code. */}
        <section
          aria-labelledby="order-heading"
          className={`${BRAND_PANEL} p-4 sm:p-6 lg:self-start`}
        >
          <p id="order-heading" className={BRAND_EYEBROW}>
            {c('yourOrder')}
          </p>
          <h2 className="mt-2 font-brand-display text-brand-d3 text-brand-ink">
            {booking.event.title}
          </h2>
          <p className="mt-1 text-brand-ui text-brand-ink-2">
            {venueWhenText(booking.eventSession.startsAt, booking.timeZone ?? undefined)}
          </p>
          {where ? <p className="text-brand-ui text-brand-ink-2">{where}</p> : null}

          <div className="mt-5 space-y-2 border-t border-brand-line pt-5">
            {/*
              The seats, named, before the money moves.

              Reported from QA: this screen showed "2 x A" — a count and a ticket-type name —
              so a buyer choosing reserved seats had no way to confirm they were buying the
              ones they picked. It is the last point where a mistake is free to fix.
            */}
            {(booking.seatLabels?.length ?? 0) > 0 ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-2">
                <span className="text-brand-ui text-brand-ink-2">
                  {booking.seatLabels!.length === 1 ? k('seat') : k('seats')}
                </span>
                <span className="text-brand-ui font-semibold text-brand-ink">
                  {booking.seatLabels!.join(', ')}
                </span>
              </div>
            ) : null}

            {booking.items.map((i, idx) => (
              <Row
                key={idx}
                label={`${i.quantity} x ${i.label ?? i.ticketType?.name ?? i.addOn?.name ?? i.bundle?.name ?? k('item')}`}
                value={money(i.unitPriceMinor * i.quantity, booking.currency, undefined, digits)}
              />
            ))}
          </div>
          {/*
            Somewhere to put a code.

            Reported from QA: an organizer created a promotion and found nowhere in the buying
            flow to use it. The API had accepted a code since the beginning — but only when the
            booking was CREATED, which is while the buyer is picking seats and not thinking
            about money. A discount box belongs on the screen showing the total.
          */}
          <div className="mt-5 border-t border-brand-line pt-5">
            {booking.discountMinor > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-brand-ui text-brand-ink-2">{k('discountApplied')}</span>
                <button
                  type="button"
                  onClick={() => coupon.mutate(null)}
                  disabled={coupon.isPending}
                  className={`min-h-11 text-brand-meta disabled:opacity-50 ${BRAND_LINK}`}
                >
                  {k('remove')}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {(offersQ.data?.length ?? 0) > 0 && (
                  <select
                    aria-label={k('availableOffers')}
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setCode(e.target.value);
                      setCouponError(null);
                      // Applied on selection: picking an offer IS the intent, and making
                      // somebody choose it and then press Apply is a step that earns nothing.
                      coupon.mutate(e.target.value);
                    }}
                    className={`${BRAND_FIELD} w-full`}
                  >
                    <option value="">{k('availableOffers')}</option>
                    {offersQ.data!.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.code} - {o.label}
                      </option>
                    ))}
                  </select>
                )}
                <div className="flex items-start gap-2">
                  <input
                    aria-label={k('discountCode')}
                    placeholder={k('discountCode')}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.toUpperCase());
                      setCouponError(null);
                    }}
                    className={`${BRAND_FIELD} min-w-0 flex-1 uppercase placeholder:normal-case`}
                  />
                  <BrandButton
                    variant="secondary"
                    disabled={!code.trim() || coupon.isPending}
                    onClick={() => coupon.mutate(code)}
                    className="shrink-0"
                  >
                    {coupon.isPending ? k('applying') : k('apply')}
                  </BrandButton>
                </div>
              </div>
            )}
            {couponError && (
              <p role="alert" className="mt-2 text-brand-meta text-brand-critical">
                {couponError}
              </p>
            )}
          </div>
        </section>

        {/*
          ── PAYING ───────────────────────────────────────────────────────────────────
          The money and the one action, together, beside the order on a wide screen and under
          it on a phone. The breakdown is the same component the event page showed - the same
          rows, the same total - so nothing changes between "I chose" and "I pay".
        */}
        <section
          aria-labelledby="pay-heading"
          className={`${BRAND_PANEL} p-4 sm:p-6 lg:sticky lg:top-24 lg:h-fit`}
        >
          <h2 id="pay-heading" className="font-brand-display text-brand-d3 text-brand-ink">
            {c('steps.payment')}
          </h2>
          <div className="mt-2">
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
              totalLabel={k('totalPayable')}
              fractionDigits={digits}
            />
          </div>

          {paymentsActivating && (
            /*
              Deliberately an INFO tint, not the error red: nothing went wrong for this buyer. The
              operator line names the legal entity, because the person most likely to read this
              first is the payment gateway's own reviewer opening the site we gave them.
            */
            <div
              role="status"
              className="mt-5 space-y-2 rounded-brand-control bg-brand-info-tint p-4"
            >
              <p className="text-brand-ui font-semibold text-brand-ink">
                {k('paymentsActivatingTitle')}
              </p>
              <p className="text-brand-ui text-brand-ink-2">
                {k(paymentsActivatingCopy(booking.currency).body)}
              </p>
              {paymentsActivatingCopy(booking.currency).showOperator && (
                <p className="text-brand-meta text-brand-ink-3">
                  {k('paymentsActivatingOperator')}
                </p>
              )}
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-5 rounded-brand-control bg-brand-critical-tint px-3 py-2 text-brand-ui text-brand-critical"
            >
              {error}
            </p>
          )}

          {expired ? (
            <div className="mt-5 space-y-3 text-center">
              <p className="text-brand-ui text-brand-ink-2">{k('ticketsReleased')}</p>
              <Link
                href={`/events/${booking.event.slug}`}
                className={`${brandButtonClasses('primary', 'lg')} w-full`}
              >
                {k('backToEvent')}
              </Link>
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              <BrandButton
                size="lg"
                className="w-full"
                aria-busy={pay.isPending || undefined}
                disabled={pay.isPending}
                onClick={() => pay.mutate()}
              >
                {pay.isPending
                  ? k('processing')
                  : k('payAmount', {
                      amount: money(booking.totalMinor, booking.currency, undefined, digits),
                    })}
              </BrandButton>
              <p className="flex items-start gap-2 text-brand-meta text-brand-ink-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {k('securePaymentNote')}
              </p>
              <BrandButton
                variant="quiet"
                className="w-full"
                disabled={pay.isPending}
                onClick={() => setConfirmingCancel(true)}
              >
                {k('cancelBooking')}
              </BrandButton>
              <Dialog
                open={confirmingCancel}
                onClose={() => setConfirmingCancel(false)}
                title={k('cancelBookingTitle')}
              >
                <div className="space-y-4">
                  <p className="text-brand-body text-brand-ink-2">{k('cancelBookingBody')}</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <BrandActionButton
                      variant="secondary"
                      disabled={cancelBooking.isPending}
                      onClick={() => setConfirmingCancel(false)}
                    >
                      {k('keepBooking')}
                    </BrandActionButton>
                    <BrandActionButton
                      variant="danger"
                      loading={cancelBooking.isPending}
                      onClick={() => cancelBooking.mutate()}
                    >
                      {k('confirmCancelBooking')}
                    </BrandActionButton>
                  </div>
                </div>
              </Dialog>
            </div>
          )}
        </section>
      </div>

      {!expired && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
          {/* What happens after paying, said plainly: words, not three icon tiles. */}
          <ul className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: QrCode, label: k('instantQr') },
              {
                icon: RefreshCcw,
                label:
                  booking.event.refundsEnabled === false
                    ? k('refundNoneShort')
                    : k('refundablePerPolicy'),
              },
              { icon: ShieldCheck, label: k('noHiddenFees') },
            ].map((item) => (
              <li
                key={item.label}
                className="flex items-center gap-2 text-brand-meta text-brand-ink-2"
              >
                <item.icon className="h-4 w-4 shrink-0 text-brand-ink-3" aria-hidden />
                {item.label}
              </li>
            ))}
          </ul>
          <RefundTerms
            refundsEnabled={booking.event.refundsEnabled}
            refundCutoffHours={booking.event.refundCutoffHours}
            refundPolicy={booking.event.refundPolicy}
          />
        </div>
      )}
    </PayShell>
  );
}

/**
 * Review and pay, for a buyer with no account.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 * No discount box, no "keep my seats", no list of offers. Every one of those is an account
 * endpoint: the server would refuse the call, so the control would be a button that cannot
 * work. The hold timer stays, because a guest is on exactly the same clock as everybody else.
 *
 * The Razorpay path also skips the signature check the account path makes. There is no guest
 * verify route, and there does not need to be: that call was never proof of payment anyway --
 * the signed webhook confirms the booking, and the confirmation screen polls for it.
 */
function GuestPayment({ id, anonSession }: { id: string; anonSession: string }) {
  const k = useTranslations('storefront.checkout');
  const c = useTranslations('storefront.confirmation');
  const g = useTranslations('storefront.guest');
  const tx = useTranslations('common');
  const { money } = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /*
    The same declared state as the signed-in view above, because a guest reaches the same refusal.

    This was missed the first time and only a walkthrough of the LIVE site found it: buying without
    an account is the path a payment gateway's reviewer actually takes, and it still answered a
    503 with a red "Payment could not be completed. Please try again." - telling the one person we
    most needed to inform that our checkout was broken.
  */
  const [paymentsActivating, setPaymentsActivating] = useState(false);
  /*
    Why cancellation being unavailable is STATE and not just a message.

    Reported from QA: "I click on cancel booking and select yes cancel nothing is happening, still
    on review and pay". The server was refusing the cancel (fixed on its side), but the screen was
    also at fault: the refusal was written as one muted caption ABOVE the summary, the total and
    both buttons. On a phone the buyer is looking at the button they just pressed, so the message
    was off screen, and the button that had done nothing was still sitting there inviting a second
    try. Holding it as state lets the answer replace the button, in the button's own place.
  */
  const [cancelUnavailable, setCancelUnavailable] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const {
    data: view,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['guest-booking', id],
    queryFn: () => api.getGuestBooking(id, anonSession),
  });

  // No deadline means no countdown to show, which is a different thing from a deadline of zero.
  const countdown = useCountdown(view?.holdExpiresAt ?? undefined);

  const pay = useMutation({
    mutationFn: async () => {
      const payResult = await api.payGuestBooking(id, anonSession);
      const { clientActionUrl } = payResult;
      if (isExternalUrl(clientActionUrl)) {
        // Real Stripe: the hosted Checkout page. Only the signed webhook confirms the booking.
        window.location.href = clientActionUrl;
        return { redirected: true as const };
      }
      if (payResult.provider === 'razorpay' && payResult.razorpay) {
        const rzp = payResult.razorpay;
        const Razorpay = await loadRazorpay();
        let failed = false;
        const checkout = new Razorpay({
          key: rzp.keyId,
          order_id: rzp.orderId,
          amount: rzp.amountMinor,
          currency: rzp.currency,
          name: rzp.name,
          description: rzp.description,
          prefill: rzp.prefill,
          ...(rzp.upiEnabled
            ? {
                config: {
                  display: {
                    blocks: {
                      upi: {
                        name: k('upiBlockName'),
                        instruments: [{ method: 'upi', flows: ['qr', 'intent'] }],
                      },
                    },
                    sequence: ['block.upi'],
                    preferences: { show_default_blocks: true },
                  },
                },
              }
            : {}),
          handler: () => {
            qc.invalidateQueries({ queryKey: ['guest-booking', id] });
            router.push(`/booking/${id}/confirmation`);
          },
          modal: {
            ondismiss: () => {
              if (!failed) setError(k('paymentCancelled'));
            },
          },
        });
        checkout.on('payment.failed', (response) => {
          failed = true;
          setError(k(`failure.${razorpayFailureReason(response.error)}`));
        });
        checkout.open();
        return { redirected: true as const };
      }
      // Local/dev mock. A real gateway calls our signed webhook instead.
      await api.mockPay(id, 'succeeded');
      return { redirected: false as const };
    },
    onSuccess: (result) => {
      if (result.redirected) return;
      qc.invalidateQueries({ queryKey: ['guest-booking', id] });
      router.push(`/booking/${id}/confirmation`);
    },
    onError: (err: unknown) => {
      // No gateway can take this currency yet: state, not a failure. See the signed-in view.
      if (err instanceof ApiRequestError && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE') {
        setPaymentsActivating(true);
        setError(null);
        return;
      }
      const status = (err as { status?: number }).status;
      setError(status === 402 ? k('failure.CARD_DECLINED') : k('paymentFailed'));
    },
  });

  // Giving the tickets back early, with the session token that is the guest's only credential.
  const cancelBooking = useMutation({
    mutationFn: () => api.cancelGuestBooking(id, anonSession),
    onSuccess: () => {
      setConfirmingCancel(false);
      forgetGuestBooking(id);
      rememberCancelledGuestBooking(id);
      qc.invalidateQueries({ queryKey: ['guest-booking', id] });
      router.push('/');
    },
    onError: (err: unknown) => {
      setConfirmingCancel(false);
      /*
        A 409 here is not a failure worth alarming anybody about: the hold runs out by itself and
        the seats go back on sale. But it does mean this button can never work for this booking, so
        it stops being offered and says why, where the button was.
      */
      const unavailable = err instanceof ApiRequestError && err.status === 409;
      setCancelUnavailable(unavailable);
      if (!unavailable) setError(k('cancelFailed'));
      qc.invalidateQueries({ queryKey: ['guest-booking', id] });
    },
  });

  if (isError)
    return (
      <BrandStatePage>
        <BrandLoadError message={k('loadError')} onRetry={() => refetch()} />
      </BrandStatePage>
    );
  if (isLoading || !view)
    return (
      <BrandStatePage>
        <BrandSkeleton className="h-72 w-full" />
      </BrandStatePage>
    );

  if (view.status !== 'PENDING_PAYMENT') {
    const statusKey = `status.${view.status}`;
    const statusLabel = tx.has(statusKey)
      ? tx(statusKey)
      : view.status.replaceAll('_', ' ').toLowerCase();
    return (
      <PayShell>
        <div className={`${BRAND_PANEL} mx-auto max-w-md p-6 text-center`}>
          <p className="text-brand-body text-brand-ink">
            {k('bookingStatus', { status: statusLabel })}
          </p>
          <BrandButton className="mt-4" onClick={() => router.push(`/booking/${id}/confirmation`)}>
            {k('viewBooking')}
          </BrandButton>
        </div>
      </PayShell>
    );
  }

  const expired = countdown.expired;

  return (
    <PayShell>
      <PayHeader
        title={k('reviewAndPay')}
        steps={BOOKING_STEPS.map((step) => c(`steps.${step}`))}
        lead={g('payingAsGuest')}
      />
      <HoldTimer countdown={countdown} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
        {/*
          The guest summary is shared with the emailed booking link (/booking/access), which has
          not moved to the brand layer yet; it keeps its own card here until that page does.
        */}
        <div className="min-w-0">
          <GuestBookingSummary view={view} />
        </div>

        <section
          aria-labelledby="pay-heading"
          className={`${BRAND_PANEL} p-4 sm:p-6 lg:sticky lg:top-24 lg:h-fit`}
        >
          <h2 id="pay-heading" className="font-brand-display text-brand-d3 text-brand-ink">
            {c('steps.payment')}
          </h2>
          <div className="mt-3 flex items-baseline justify-between gap-4 border-t border-brand-line pt-3">
            <span className="text-brand-ui text-brand-ink-2">{k('totalPayable')}</span>
            <span className="text-brand-figure-sm tabular-nums text-brand-ink">
              {money(view.totals.totalMinor, view.currency)}
            </span>
          </div>

          {paymentsActivating && (
            <div
              role="status"
              className="mt-5 space-y-2 rounded-brand-control bg-brand-info-tint p-4"
            >
              <p className="text-brand-ui font-semibold text-brand-ink">
                {k('paymentsActivatingTitle')}
              </p>
              <p className="text-brand-ui text-brand-ink-2">
                {k(paymentsActivatingCopy(view.currency).body)}
              </p>
              {paymentsActivatingCopy(view.currency).showOperator && (
                <p className="text-brand-meta text-brand-ink-3">
                  {k('paymentsActivatingOperator')}
                </p>
              )}
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="mt-5 rounded-brand-control bg-brand-critical-tint px-3 py-2 text-brand-ui text-brand-critical"
            >
              {error}
            </p>
          )}

          {expired ? (
            <div className="mt-5 space-y-3 text-center">
              <p className="text-brand-ui text-brand-ink-2">{k('ticketsReleased')}</p>
              <Link
                href={`/events/${view.event.slug}`}
                className={`${brandButtonClasses('primary', 'lg')} w-full`}
              >
                {k('backToEvent')}
              </Link>
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              <BrandButton
                size="lg"
                className="w-full"
                aria-busy={pay.isPending || undefined}
                disabled={pay.isPending}
                onClick={() => pay.mutate()}
              >
                {pay.isPending
                  ? k('processing')
                  : k('payAmount', { amount: money(view.totals.totalMinor, view.currency) })}
              </BrandButton>
              <p className="flex items-start gap-2 text-brand-meta text-brand-ink-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {k('securePaymentNote')}
              </p>
              {cancelUnavailable ? (
                <p
                  role="status"
                  className="rounded-brand-control bg-brand-sunken px-4 py-3 text-brand-ui text-brand-ink-2"
                >
                  {g('cancelUnavailable')}
                </p>
              ) : (
                <BrandButton
                  variant="quiet"
                  className="w-full"
                  disabled={pay.isPending}
                  onClick={() => setConfirmingCancel(true)}
                >
                  {k('cancelBooking')}
                </BrandButton>
              )}
              <Dialog
                open={confirmingCancel}
                onClose={() => setConfirmingCancel(false)}
                title={k('cancelBookingTitle')}
              >
                <div className="space-y-4">
                  <p className="text-brand-body text-brand-ink-2">{k('cancelBookingBody')}</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <BrandActionButton
                      variant="secondary"
                      disabled={cancelBooking.isPending}
                      onClick={() => setConfirmingCancel(false)}
                    >
                      {k('keepBooking')}
                    </BrandActionButton>
                    <BrandActionButton
                      variant="danger"
                      loading={cancelBooking.isPending}
                      onClick={() => cancelBooking.mutate()}
                    >
                      {k('confirmCancelBooking')}
                    </BrandActionButton>
                  </div>
                </div>
              </Dialog>
              <p className="text-center text-brand-meta text-brand-ink-3">
                {g('wantAnAccount')}{' '}
                <Link href="/register" className={BRAND_LINK}>
                  {g('createAccountLater')}
                </Link>
              </p>
            </div>
          )}
        </section>
      </div>

      {!expired && (
        <RefundTerms
          refundsEnabled={view.event.refundsEnabled}
          refundCutoffHours={view.event.refundCutoffHours}
          refundPolicy={view.event.refundPolicy}
        />
      )}
    </PayShell>
  );
}
