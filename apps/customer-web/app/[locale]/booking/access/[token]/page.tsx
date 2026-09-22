'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Button, ButtonLink, Card, Skeleton } from '@/components/ui';
import { GuestBookingSummary, GuestTickets } from '@/components/guest-booking-view';
import { GuestClaimCard, GuestInvoiceCard, GuestRefundCard } from '@/components/guest-self-service';
import { guestTokenFor, isGuestBooking } from '@/lib/guest-session';
import { useMounted } from '@/lib/use-mounted';

/**
 * The page an emailed booking link opens.
 *
 * ── WHY IT NEEDS NOTHING FROM THE BROWSER ──────────────────────────────────────────
 * This is the only way back to a guest booking that survives a new phone, a cleared browser or
 * a forwarded email. So SEEING the booking asks for nothing: no account, no code, no anonymous
 * session. The token in the URL is the whole credential, which is why the server gives it a life
 * span and why this page prints when that runs out -- somebody who has to show a ticket at a
 * door needs to know their link expires before they are standing at the door.
 *
 * ── WHERE THAT STOPS ───────────────────────────────────────────────────────────────
 * The link is forwardable, so it buys exactly what a forwarded ticket already gives away: the
 * QR. Getting the invoice or asking for a refund needs the address the booking was paid with,
 * which the forwarding does not carry. See components/guest-self-service.tsx.
 *
 * ── WHY IT DOES NOT OFFER TO PAY ───────────────────────────────────────────────────
 * Paying needs the anonymous session that created the booking, and an access link is not one.
 * When THIS browser happens to be the one holding that session the button appears, and
 * otherwise the page says the booking is not paid for rather than offering a button that
 * would be refused.
 */
export default function BookingAccessPage() {
  const g = useTranslations('storefront.guest');
  const c = useTranslations('storefront.confirmation');
  const tx = useTranslations('common');
  const { token } = useParams<{ token: string }>();
  const { dateTime } = useFormat();
  const mounted = useMounted();

  const {
    data: view,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['guest-access', token],
    queryFn: () => api.guestBookingByAccessToken(token),
    retry: false,
  });

  if (isLoading)
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );

  if (isError || !view) {
    /*
      An expired or already-used link is not a broken page, and "Try again" cannot fix it --
      so the way forward is to ask for a fresh link, which is what /booking/find does.
    */
    return (
      <div className="mx-auto max-w-lg">
        <Card className="space-y-3 text-center">
          <h1 className="text-title font-semibold text-text-primary">{g('linkDeadTitle')}</h1>
          <p className="text-[0.9375rem] text-text-secondary">{g('linkDeadBody')}</p>
          <div className="flex flex-col gap-3 pt-1 sm:flex-row">
            <ButtonLink href="/booking/find" className="w-full sm:flex-1">
              {g('findTitle')}
            </ButtonLink>
            {/* A dropped connection looks the same from here, so the retry stays offered. */}
            <Button variant="outline" className="w-full sm:flex-1" onClick={() => refetch()}>
              {tx('action.retry')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const confirmed = view.status === 'CONFIRMED';
  const pending = view.status === 'PENDING_PAYMENT';
  // Only this browser can pay: the anonymous session that made the booking lives here or nowhere.
  const canPayHere = mounted && pending && isGuestBooking(view.id);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-h2 font-bold tracking-tight text-text-primary">{g('yourBooking')}</h1>

      <GuestBookingSummary view={view} />

      {confirmed ? (
        <>
          <GuestTickets view={view} printHref={`/booking/access/${token}/print`} />
          {/*
            Everything else a booking needs after the tickets themselves, and only for a booking
            that is paid for: an unpaid one has no invoice to issue, nothing to refund, and
            nothing worth putting in an account.

            The order is the order somebody asks for them in. The invoice is the common errand;
            a refund is the uncommon one; keeping the booking is the thing they had not thought
            of until the page offered it.
          */}
          <GuestInvoiceCard token={token} emailMasked={view.buyer.emailMasked} />
          <GuestRefundCard token={token} emailMasked={view.buyer.emailMasked} />
          {/*
            The access token proves the claim here. This booking's own anonymous session goes
            with it when this browser is the one that bought it, which costs nothing and is what
            makes the same card work on the confirmation screen, where there is no access token.
          */}
          <GuestClaimCard
            bookingId={view.id}
            accessToken={token}
            anonSession={mounted ? guestTokenFor(view.id) : null}
          />
        </>
      ) : pending ? (
        <Card className="space-y-3">
          <p className="text-[0.9375rem] text-text-secondary">{g('notPaidYet')}</p>
          {canPayHere ? (
            <ButtonLink href={`/booking/${view.id}/payment`} className="w-full">
              {c('returnToPayment')}
            </ButtonLink>
          ) : (
            <ButtonLink href={`/events/${view.event.slug}`} variant="outline" className="w-full">
              {c('backToEvent')}
            </ButtonLink>
          )}
        </Card>
      ) : (
        <Card className="space-y-3">
          <p className="text-[0.9375rem] text-text-secondary">{g('noTicketsOnBooking')}</p>
          <ButtonLink href={`/events/${view.event.slug}`} variant="outline" className="w-full">
            {c('backToEvent')}
          </ButtonLink>
        </Card>
      )}

      {view.accessExpiresAt ? (
        <p className="text-caption text-text-muted">
          {g('linkExpires', { when: dateTime(view.accessExpiresAt) })}
        </p>
      ) : null}
    </div>
  );
}
