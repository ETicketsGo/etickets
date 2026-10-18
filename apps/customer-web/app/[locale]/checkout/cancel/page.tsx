'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
 * Buyer landed here after cancelling / abandoning the hosted Stripe Checkout.
 * No charge was made. We offer a route straight back to the booking's payment
 * page (the hold may still be live) or to browse other events.
 */
function CheckoutCancel() {
  const r = useTranslations('storefront.checkoutReturn');
  const n = useTranslations('common.nav');
  const params = useSearchParams();
  const bookingId = params.get('booking');

  return (
    <BrandCenteredPage>
      <BrandFormPanel className="space-y-5 text-center">
        <span
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-caution-tint text-brand-caution"
          aria-hidden
        >
          <XCircle className="h-7 w-7" />
        </span>
        <div className="space-y-2">
          <h1 className={BRAND_PAGE_TITLE}>{r('cancelledTitle')}</h1>
          <p className={BRAND_LEAD}>{r('cancelledBody')}</p>
        </div>
        <div className="flex flex-col gap-3">
          {bookingId && (
            <Link
              href={`/booking/${bookingId}/payment`}
              className={`${brandButtonClasses('primary', 'lg')} w-full`}
            >
              {r('returnToPayment')}
            </Link>
          )}
          <Link
            href="/events"
            className={`${brandButtonClasses(bookingId ? 'secondary' : 'primary', 'lg')} w-full`}
          >
            {n('browseEvents')}
          </Link>
        </div>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}

export default function CheckoutCancelPage() {
  return (
    <Suspense
      fallback={
        <BrandCenteredPage>
          <BrandSkeleton className="h-48 w-full" />
        </BrandCenteredPage>
      }
    >
      <CheckoutCancel />
    </Suspense>
  );
}
