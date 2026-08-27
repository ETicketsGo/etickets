'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { XCircle } from 'lucide-react';
import { ButtonLink, Card } from '@/components/ui';

/**
 * Buyer landed here after cancelling / abandoning the hosted Stripe Checkout.
 * No charge was made. We offer a route straight back to the booking's payment
 * page (the hold may still be live) or to browse other events.
 */
function CheckoutCancel() {
  const params = useSearchParams();
  const bookingId = params.get('booking');

  return (
    <Card className="mx-auto max-w-md space-y-5 text-center">
      <div
        className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-tint-warning text-status-warning"
        aria-hidden
      >
        <XCircle className="h-8 w-8" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Payment cancelled</h1>
        <p className="text-[0.9375rem] text-text-secondary">
          You haven’t been charged. If your ticket hold is still active you can pick up right where
          you left off.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {bookingId && (
          <ButtonLink href={`/booking/${bookingId}/payment`} className="w-full">
            Return to payment
          </ButtonLink>
        )}
        <ButtonLink href="/events" variant={bookingId ? 'outline' : 'primary'} className="w-full">
          Browse events
        </ButtonLink>
      </div>
    </Card>
  );
}

export default function CheckoutCancelPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto h-48 max-w-md animate-pulse rounded-lg bg-background-subtle" />
      }
    >
      <CheckoutCancel />
    </Suspense>
  );
}
