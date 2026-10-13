'use client';

import { useTranslations } from 'next-intl';
import { BrandButton } from '@eticketsgo/web-kit';

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
  error,
}: {
  count: number;
  seats: string;
  amount: string;
  pending: boolean;
  disabled: boolean;
  onPay: () => void;
  detailsHref: string;
  /**
   * Why the last attempt to pay failed, kept beside the button that was pressed.
   *
   * Visual only (`aria-hidden`): the same sentence is announced once, by the alert in the
   * summary card, which is on the page at every width. Two live regions would read it twice.
   */
  error?: string | null;
}) {
  const s = useTranslations('storefront.seats');

  return (
    <div
      data-brand="customer"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-brand-line bg-brand-surface px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 font-brand-text shadow-brand-overlay lg:hidden print:hidden"
    >
      {error ? (
        <p
          aria-hidden
          data-testid="booking-bar-error"
          className="mx-auto mb-2 max-w-shell rounded-brand-control bg-brand-critical-tint px-3 py-2 text-brand-meta text-brand-critical"
        >
          {error}
        </p>
      ) : null}
      <div className="mx-auto flex max-w-shell items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-brand-meta text-brand-ink-2">
            {s('seatsChosen', { count, seats })}
          </p>
          <p className="flex items-baseline gap-2">
            <span className="text-brand-figure-sm tabular-nums text-brand-ink">{amount}</span>
            {/*
              Not on the narrowest phones: at 320px the link wrapped under the total and doubled
              the bar's height over the seats. The full breakdown is on the page right below
              the map, which is where the link goes anyway.
            */}
            <a
              href={detailsHref}
              className="hidden whitespace-nowrap rounded-sm text-brand-meta font-medium text-brand-ink underline decoration-brand-line-strong underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus min-[360px]:inline"
            >
              {s('priceDetails')}
            </a>
          </p>
        </div>
        <BrandButton
          size="lg"
          onClick={onPay}
          aria-busy={pending || undefined}
          disabled={disabled}
          className="shrink-0"
        >
          {pending ? s('holdingSeats') : s('proceedToPay')}
        </BrandButton>
      </div>
    </div>
  );
}
