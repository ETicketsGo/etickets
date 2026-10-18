'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api, tokenStore } from '@/lib/api';
import { BRAND_EYEBROW, BRAND_LINK } from '@/components/booking-brand';
import {
  BRAND_LEAD,
  BRAND_NOTE,
  BRAND_PAGE_TITLE,
  BrandCenteredPage,
  BrandFormPanel,
  BrandLoadError,
  BrandSkeleton,
} from '@/components/brand-forms';
import { GuestBookingNotHere } from '@/components/guest-booking-view';
import { guestTokenFor } from '@/lib/guest-session';
import { useMounted } from '@/lib/use-mounted';
import { Link } from '@/i18n/navigation';
import { useFormat } from '@/lib/format';
import { useTranslations } from 'next-intl';

/**
 * Seats held, money owed at the counter.
 *
 * ── WHY THIS IS NOT THE CONFIRMATION PAGE ──────────────────────────────────────────
 * The booking is not confirmed and no ticket has been issued — it is a reservation that
 * becomes a ticket when somebody hands over cash. Reusing the confirmation screen would
 * tell the buyer they were done, and they would turn up at a venue expecting to walk in.
 *
 * And it is not the payment screen either: there is no Payment row and no provider to send
 * them to, so that page would show a bill with a button that cannot work.
 *
 * ── THE GUEST FORK ─────────────────────────────────────────────────────────────────
 * A guest can reserve and pay cash as well, and their booking is not readable through the
 * account endpoint -- so this page failed with "We couldn't load this reservation" on the one
 * screen that holds the reference they have to read out at the counter. The fork is the same
 * one the payment and confirmation screens make: does this browser hold the booking.
 */
export default function ReservedPage() {
  const mounted = useMounted();
  const { id } = useParams<{ id: string }>();
  const guestToken = mounted ? guestTokenFor(id) : null;

  if (!mounted)
    return (
      <BrandCenteredPage wide>
        <BrandSkeleton className="h-72 w-full" />
      </BrandCenteredPage>
    );
  if (guestToken) return <GuestReserved id={id} anonSession={guestToken} />;
  if (!tokenStore.access) return <GuestBookingNotHere bookingId={id} />;
  return <AccountReserved />;
}

function AccountReserved() {
  const { id } = useParams<{ id: string }>();
  const b = useTranslations('storefront.booking');
  const a = useTranslations('storefront.account');
  const { money, dateTime, zoneAbbrev } = useFormat();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
  });

  if (isLoading) {
    return (
      <BrandCenteredPage wide>
        <BrandSkeleton className="h-72 w-full" />
      </BrandCenteredPage>
    );
  }
  /*
    A failed load says so and offers a retry.

    This returned null, so a dropped connection left a blank page on the one screen that
    holds the reference somebody has to read out at the counter — with nothing to say the
    reservation still exists or how to get it back.
  */
  if (isError || !data) {
    return (
      <BrandCenteredPage wide>
        <BrandLoadError message={b('loadError')} onRetry={() => refetch()} />
      </BrandCenteredPage>
    );
  }

  return (
    <BrandCenteredPage wide>
      <BrandFormPanel className="space-y-5">
        <h1 className={BRAND_PAGE_TITLE}>{b('cashTitle')}</h1>

        <p className={BRAND_LEAD}>
          {b('cashLead', { amount: money(data.totalMinor, data.currency) })}
        </p>

        {/*
        The reference, large. This is what the person at the counter asks for, and a booking
        id buried in body text is one somebody reads out wrongly over a queue.
      */}
        <div className="rounded-brand-control bg-brand-sunken p-4 text-center">
          <p className={BRAND_EYEBROW}>{b('cashRef')}</p>
          <p className="mt-1 font-mono text-brand-d3 font-semibold text-brand-ink">
            {data.reference ?? data.id.slice(-8).toUpperCase()}
          </p>
        </div>

        <dl className="space-y-1 text-brand-ui">
          <div className="flex justify-between">
            <dt className="text-brand-ink-2">{data.event.title}</dt>
            {/* The venue's clock, named — the time the counter will be open, not the phone's. */}
            <dd className="text-right font-semibold text-brand-ink">
              {dateTime(data.eventSession.startsAt, undefined, data.timeZone ?? undefined)}
              {data.timeZone ? (
                <span className="font-normal text-brand-ink-3">
                  {' '}
                  ({zoneAbbrev(data.eventSession.startsAt, data.timeZone)})
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        {/* Said plainly: no card has been charged, so nobody waits for a refund that is not owed. */}
        <p className={BRAND_NOTE}>{b('cashNote')}</p>

        <Link href="/account/bookings" className={`inline-block text-brand-meta ${BRAND_LINK}`}>
          {a('bookingsHeading')}
        </Link>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}

/** The same reservation, read with the anonymous session instead of an account. */
function GuestReserved({ id, anonSession }: { id: string; anonSession: string }) {
  const b = useTranslations('storefront.booking');
  const g = useTranslations('storefront.guest');
  const { money, dateTime, zoneAbbrev } = useFormat();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['guest-booking', id],
    queryFn: () => api.getGuestBooking(id, anonSession),
  });

  if (isLoading) {
    return (
      <BrandCenteredPage wide>
        <BrandSkeleton className="h-72 w-full" />
      </BrandCenteredPage>
    );
  }
  if (isError || !data) {
    return (
      <BrandCenteredPage wide>
        <BrandLoadError message={b('loadError')} onRetry={() => refetch()} />
      </BrandCenteredPage>
    );
  }

  return (
    <BrandCenteredPage wide>
      <BrandFormPanel className="space-y-5">
        <h1 className={BRAND_PAGE_TITLE}>{b('cashTitle')}</h1>

        <p className={BRAND_LEAD}>
          {b('cashLead', { amount: money(data.totals.totalMinor, data.currency) })}
        </p>

        <div className="rounded-brand-control bg-brand-sunken p-4 text-center">
          <p className={BRAND_EYEBROW}>{b('cashRef')}</p>
          <p className="mt-1 font-mono text-brand-d3 font-semibold text-brand-ink">
            {data.reference}
          </p>
        </div>

        <dl className="space-y-1 text-brand-ui">
          <div className="flex justify-between">
            <dt className="text-brand-ink-2">{data.event.title}</dt>
            {/* The venue's clock, named: the time the counter will be open, not the phone's. */}
            <dd className="text-right font-semibold text-brand-ink">
              {dateTime(data.event.startsAt, undefined, data.event.timeZone ?? undefined)}
              {data.event.timeZone ? (
                <span className="font-normal text-brand-ink-3">
                  {' '}
                  ({zoneAbbrev(data.event.startsAt, data.event.timeZone)})
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        <p className={BRAND_NOTE}>{b('cashNote')}</p>
        {/* How a guest finds this again: the emailed link, because there is no bookings list. */}
        <p className={BRAND_NOTE}>{g('keepTicketsBody', { email: data.buyer.emailMasked })}</p>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}
