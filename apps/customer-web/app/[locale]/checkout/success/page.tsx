'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ButtonLink, Card, Spinner } from '@/components/ui';

/**
 * Stripe returns the buyer here after a hosted Checkout session. The URL carries
 * `?booking=<id>` (from the success_url) — we use it ONLY to route the buyer to
 * the confirmation page, which polls the backend for the real booking status.
 * The session_id / return itself is NEVER treated as proof of payment; the
 * booking is confirmed only by the signed Stripe webhook.
 */
function CheckoutSuccess() {
  const r = useTranslations('storefront.checkoutReturn');
  const router = useRouter();
  const params = useSearchParams();
  const bookingId = params.get('booking');

  useEffect(() => {
    if (bookingId) {
      // Replace so the browser Back button doesn't return to the Stripe redirect.
      router.replace(`/booking/${bookingId}/confirmation`);
    }
  }, [bookingId, router]);

  if (!bookingId) {
    return (
      <Card className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">{r('thanksTitle')}</h1>
        <p className="text-[0.9375rem] text-text-secondary">{r('thanksBody')}</p>
        {/* The bookings list, which is what the button says. It used to open the tickets page. */}
        <ButtonLink href="/account/bookings" className="w-full">
          {r('goToBookings')}
        </ButtonLink>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-md space-y-4 text-center">
      <div className="flex justify-center" aria-hidden>
        <Spinner className="h-8 w-8" />
      </div>
      <h1 className="text-h2 font-bold tracking-tight text-text-primary">{r('paymentReceived')}</h1>
      <p className="text-[0.9375rem] text-text-secondary" aria-live="polite">
        {r('finalizing')}
      </p>
      <ButtonLink href={`/booking/${bookingId}/confirmation`} variant="outline" className="w-full">
        {r('viewConfirmationNow')}
      </ButtonLink>
    </Card>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto h-48 max-w-md animate-pulse rounded-lg bg-background-subtle" />
      }
    >
      <CheckoutSuccess />
    </Suspense>
  );
}
