'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { brandButtonClasses } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import {
  BRAND_LEAD,
  BRAND_PAGE_TITLE,
  BrandCenteredPage,
  BrandFormPanel,
  BrandSkeleton,
} from '@/components/brand-forms';

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
      <BrandCenteredPage>
        <BrandFormPanel className="space-y-4 text-center">
          <h1 className={BRAND_PAGE_TITLE}>{r('thanksTitle')}</h1>
          <p className={BRAND_LEAD}>{r('thanksBody')}</p>
          {/* The bookings list, which is what the button says. It used to open the tickets page. */}
          <Link
            href="/account/bookings"
            className={`${brandButtonClasses('primary', 'lg')} w-full`}
          >
            {r('goToBookings')}
          </Link>
        </BrandFormPanel>
      </BrandCenteredPage>
    );
  }

  return (
    <BrandCenteredPage>
      <BrandFormPanel className="space-y-4 text-center">
        <div className="flex justify-center" aria-hidden>
          <Loader2 className="h-8 w-8 text-brand-ink-3 motion-safe:animate-spin" />
        </div>
        <h1 className={BRAND_PAGE_TITLE}>{r('paymentReceived')}</h1>
        <p className={BRAND_LEAD} aria-live="polite">
          {r('finalizing')}
        </p>
        <Link
          href={`/booking/${bookingId}/confirmation`}
          className={`${brandButtonClasses('secondary', 'lg')} w-full`}
        >
          {r('viewConfirmationNow')}
        </Link>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense
      fallback={
        <BrandCenteredPage>
          <BrandSkeleton className="h-48 w-full" />
        </BrandCenteredPage>
      }
    >
      <CheckoutSuccess />
    </Suspense>
  );
}
