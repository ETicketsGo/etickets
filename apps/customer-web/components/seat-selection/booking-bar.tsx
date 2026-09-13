'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';

/**
 * The pay button, where a thumb is — on phones and tablets only.
 *
 * On a phone the summary card sits below a map that can be several screens tall, so "Proceed to
 * pay" was a long scroll away from the seat just chosen. This bar keeps the count, the seats and
 * the amount in view and pays from there; "Price details" jumps to the full breakdown, which
 * stays on the page (the buyer sees every fee before committing, as before). From `lg` up the
 * summary card is beside the map and this bar is not rendered.
 */
export function BookingBar({
  count,
  seats,
  amount,
  pending,
  disabled,
  onPay,
  detailsHref,
}: {
  count: number;
  seats: string;
  amount: string;
  pending: boolean;
  disabled: boolean;
  onPay: () => void;
  detailsHref: string;
}) {
  const s = useTranslations('storefront.seats');

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background-surface/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-lg backdrop-blur-md lg:hidden print:hidden">
      <div className="mx-auto flex max-w-shell items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption text-text-secondary">
            {s('seatsChosen', { count, seats })}
          </p>
          <p className="flex items-baseline gap-2">
            <span className="text-title font-bold tabular-nums text-text-primary">{amount}</span>
            <a
              href={detailsHref}
              className="rounded text-caption font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {s('priceDetails')}
            </a>
          </p>
        </div>
        <Button onClick={onPay} loading={pending} disabled={disabled} className="shrink-0">
          {pending ? s('holdingSeats') : s('proceedToPay')}
        </Button>
      </div>
    </div>
  );
}
