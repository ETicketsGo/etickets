'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { Clock, QrCode, RefreshCcw, ShieldCheck } from 'lucide-react';
import { api as webKit } from '@eticketsgo/web-kit';
import { razorpayFailureReason } from '@eticketsgo/shared-types';
import { api } from '@/lib/api';
import { loadRazorpay } from '@/lib/razorpay';
import { useFormat } from '@/lib/format';
import { Button, ButtonLink, Card, Dialog, ErrorState, Stepper, useToast } from '@/components/ui';
import { PriceBreakdown } from '@/components/price-breakdown';
import { useTranslations } from 'next-intl';

// The same step names as the confirmation screen, from the same messages.
const BOOKING_STEPS = ['tickets', 'payment', 'confirmation', 'ticket'] as const;

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between ${strong ? 'text-title font-semibold' : 'text-[0.9375rem]'}`}
    >
      <span className={strong ? 'text-text-primary' : 'text-text-secondary'}>{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}

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

export default function PaymentPage() {
  const k = useTranslations('storefront.checkout');
  const c = useTranslations('storefront.confirmation');
  const tx = useTranslations('common');
  const { money, dateTime } = useFormat();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
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
      // The API returns 402 for a declined/insufficient-funds payment — tell the
      // buyer specifically so they can try another method (see all-exceptions.filter).
      const status = (err as { status?: number }).status;
      setError(status === 402 ? k('failure.CARD_DECLINED') : k('paymentFailed'));
    },
  });

  if (isError) return <ErrorState message={k('loadError')} onRetry={() => refetch()} />;
  if (isLoading || !booking)
    return <div className="h-72 animate-pulse rounded-lg bg-background-subtle" />;

  if (booking.status !== 'PENDING_PAYMENT') {
    // The status in the reader's language where the catalogue names it; a status it does
    // not know yet is still shown, spelled out, rather than hidden.
    const statusKey = `status.${booking.status}`;
    const statusLabel = tx.has(statusKey)
      ? tx(statusKey)
      : booking.status.replaceAll('_', ' ').toLowerCase();
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-text-primary">{k('bookingStatus', { status: statusLabel })}</p>
        <Button className="mt-4" onClick={() => router.push(`/booking/${id}/confirmation`)}>
          {k('viewBooking')}
        </Button>
      </Card>
    );
  }

  const expired = countdown.expired;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Stepper steps={BOOKING_STEPS.map((s) => c(`steps.${s}`))} current={1} />
      <h1 className="text-h2 font-bold tracking-tight text-text-primary">{k('reviewAndPay')}</h1>

      {/* Hold timer */}
      <div
        className={`flex items-center justify-between rounded-md border px-4 py-3 ${
          expired
            ? 'border-status-error/30 bg-status-error/5'
            : countdown.totalSeconds < 120
              ? 'border-status-warning/30 bg-status-warning/5'
              : 'border-border bg-background-subtle/60'
        }`}
      >
        <span className="flex items-center gap-2 text-[0.9375rem] text-text-secondary">
          <Clock className={`h-4 w-4 ${expired ? 'text-status-error' : 'text-text-muted'}`} />
          {expired ? k('holdExpiredTitle') : k('ticketsHeldForYou')}
        </span>
        {!expired && (
          <span
            className={`font-mono text-title font-semibold tabular-nums ${
              countdown.totalSeconds < 120 ? 'text-status-warning' : 'text-text-primary'
            }`}
            aria-live="polite"
          >
            {countdown.label}
          </span>
        )}
      </div>

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
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-status-warning/30 bg-tint-warning px-4 py-3"
        >
          <span className="text-[0.9375rem] text-text-primary">
            {extendHold.data?.extensionsRemaining === 0
              ? k('noMoreExtensions')
              : `${k('expiringSoon')} ${k('needMoreTime')}`}
          </span>
          {extendHold.data?.extensionsRemaining !== 0 && (
            <Button
              variant="outline"
              size="sm"
              loading={extendHold.isPending}
              disabled={extendHold.isPending}
              onClick={() => extendHold.mutate()}
            >
              {extendHold.isPending ? k('extending') : k('keepMySeats')}
            </Button>
          )}
        </div>
      )}

      <Card className="space-y-3">
        <div>
          <p className="font-semibold text-text-primary">{booking.event.title}</p>
          <p className="text-[0.9375rem] text-text-muted">
            {dateTime(booking.eventSession.startsAt, undefined, booking.timeZone ?? undefined)}
          </p>
        </div>
        <div className="space-y-1 border-t border-border pt-3">
          {/*
            The seats, named, before the money moves.

            Reported from QA: this screen showed "2 x A" — a count and a ticket-type name —
            so a buyer choosing reserved seats had no way to confirm they were buying the
            ones they picked. It is the last point where a mistake is free to fix.
          */}
          {(booking.seatLabels?.length ?? 0) > 0 ? (
            <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border pb-3">
              <span className="text-[0.9375rem] text-text-secondary">
                {booking.seatLabels!.length === 1 ? k('seat') : k('seats')}
              </span>
              <span className="font-medium text-text-primary">
                {booking.seatLabels!.join(', ')}
              </span>
            </div>
          ) : null}

          {booking.items.map((i, idx) => (
            <Row
              key={idx}
              label={`${i.quantity} × ${i.label ?? i.ticketType?.name ?? i.addOn?.name ?? i.bundle?.name ?? k('item')}`}
              value={money(i.unitPriceMinor * i.quantity, booking.currency)}
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
        <div className="mb-3 border-t border-border pt-3">
          {booking.discountMinor > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.9375rem] text-text-secondary">{k('discountApplied')}</span>
              <button
                type="button"
                onClick={() => coupon.mutate(null)}
                disabled={coupon.isPending}
                className="text-caption text-text-muted underline hover:text-text-primary disabled:opacity-50"
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
                  className="w-full rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <option value="">{k('availableOffers')}</option>
                  {offersQ.data!.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.code} — {o.label}
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
                  className="min-w-0 flex-1 rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] uppercase text-text-primary placeholder:normal-case placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <button
                  type="button"
                  disabled={!code.trim() || coupon.isPending}
                  onClick={() => coupon.mutate(code)}
                  className="shrink-0 rounded-md border border-border px-3 py-2 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-subtle disabled:opacity-40"
                >
                  {coupon.isPending ? k('applying') : k('apply')}
                </button>
              </div>
            </div>
          )}
          {couponError && (
            <p role="alert" className="mt-1.5 text-caption text-status-error">
              {couponError}
            </p>
          )}
        </div>

        {/*
          ── THE SAME BREAKDOWN THE EVENT PAGE SHOWED ──────────────────────────────────
          This screen used to itemise the fee its own way — "Booking fee ₹20" and "Payment
          fee ₹60.38" — while the event page showed "Platform fee ₹80.38" for the identical
          money. Same order, two presentations, and a buyer left to work out whether they had
          just been charged something new between one screen and the next.

          It also spelled its labels in hardcoded English, so a French checkout showed
          "Booking fee". Reusing the shared component fixes the disagreement and the
          translation in the same move, and there is now one place where the rule "these rows
          must add up to the total" is tested.
        */}
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
        />
      </Card>

      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}

      {expired ? (
        <div className="space-y-3 text-center">
          <p className="text-[0.9375rem] text-text-muted">{k('ticketsReleased')}</p>
          <ButtonLink href={`/events/${booking.event.slug}`} className="w-full">
            {k('backToEvent')}
          </ButtonLink>
        </div>
      ) : (
        <>
          <Button className="w-full" loading={pay.isPending} onClick={() => pay.mutate()}>
            {pay.isPending
              ? k('processing')
              : k('payAmount', { amount: money(booking.totalMinor, booking.currency) })}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={pay.isPending}
            onClick={() => setConfirmingCancel(true)}
          >
            {k('cancelBooking')}
          </Button>
          <Dialog
            open={confirmingCancel}
            onClose={() => setConfirmingCancel(false)}
            title={k('cancelBookingTitle')}
          >
            <div className="space-y-4">
              <p className="text-[0.9375rem] text-text-secondary">{k('cancelBookingBody')}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={cancelBooking.isPending}
                  onClick={() => setConfirmingCancel(false)}
                >
                  {k('keepBooking')}
                </Button>
                <Button
                  variant="danger"
                  loading={cancelBooking.isPending}
                  onClick={() => cancelBooking.mutate()}
                >
                  {k('confirmCancelBooking')}
                </Button>
              </div>
            </div>
          </Dialog>

          {/* Booking confidence */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { icon: QrCode, label: k('instantQr') },
              { icon: RefreshCcw, label: k('refundablePerPolicy') },
              { icon: ShieldCheck, label: k('noHiddenFees') },
            ].map((c) => (
              <div
                key={c.label}
                className="rounded-md border border-border bg-background-surface p-3"
              >
                <c.icon className="mx-auto h-4 w-4 text-status-success" />
                <p className="mt-1.5 text-caption text-text-muted">{c.label}</p>
              </div>
            ))}
          </div>
          <p className="flex items-center justify-center gap-1.5 text-center text-caption text-text-muted">
            <ShieldCheck className="h-3.5 w-3.5" />
            {k('securePaymentNote')}
          </p>
        </>
      )}
    </div>
  );
}
