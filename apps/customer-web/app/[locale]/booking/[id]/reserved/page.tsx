'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Card, Spinner } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { money, dateTime } from '@/lib/format';
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
 */
export default function ReservedPage() {
  const { id } = useParams<{ id: string }>();
  const b = useTranslations('storefront.booking');

  const { data, isLoading } = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.getBooking(id),
  });

  if (isLoading) {
    return (
      <main className="grid min-h-[50vh] place-items-center">
        <Spinner />
      </main>
    );
  }
  if (!data) return null;

  return (
    <Card className="mx-auto mt-8 max-w-lg space-y-4">
      <h1 className="text-title font-semibold text-text-primary">{b('cashTitle')}</h1>

      <p className="text-[0.9375rem] text-text-secondary">
        {b('cashLead', { amount: money(data.totalMinor, data.currency) })}
      </p>

      {/*
        The reference, large. This is what the person at the counter asks for, and a booking
        id buried in body text is one somebody reads out wrongly over a queue.
      */}
      <div className="rounded-md border border-border bg-background-canvas p-4 text-center">
        <p className="text-caption uppercase tracking-wide text-text-muted">{b('cashRef')}</p>
        <p className="mt-1 font-mono text-title font-semibold text-text-primary">
          {data.reference ?? data.id.slice(-8).toUpperCase()}
        </p>
      </div>

      <dl className="space-y-1 text-[0.9375rem]">
        <div className="flex justify-between">
          <dt className="text-text-muted">{data.event.title}</dt>
          <dd className="text-text-primary">{dateTime(data.eventSession.startsAt)}</dd>
        </div>
      </dl>

      {/* Said plainly: no card has been charged, so nobody waits for a refund that is not owed. */}
      <p className="text-caption text-text-muted">{b('cashNote')}</p>

      <Link href="/account/bookings" className="text-caption text-action-primary underline">
        My bookings
      </Link>
    </Card>
  );
}
