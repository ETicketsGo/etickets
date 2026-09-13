'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_SEATS_PER_BOOKING } from '@eticketsgo/web-kit';

/**
 * How many tickets — a row of numbers, not a dialog.
 *
 * ── WHY NOT BOOKMYSHOW'S POP-UP ────────────────────────────────────────────────────
 * BookMyShow opens a "How many seats?" dialog over the map before you can see a single seat,
 * and makes you close it to look. Here the numbers sit above the map: choose one and a tap on a
 * seat picks that many seats side by side; ignore them and every tap simply toggles one seat,
 * as the map always behaved. Choosing the chosen number again goes back to one-by-one.
 */
export function TicketCount({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (count: number | null) => void;
}) {
  const t = useTranslations('storefront.seats');
  const labelId = useId();

  return (
    <div className="min-w-0">
      <p id={labelId} className="text-caption font-semibold text-text-secondary">
        {t('ticketsHeading')}
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        className="-mx-1 mt-1.5 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        {Array.from({ length: MAX_SEATS_PER_BOOKING }, (_, index) => index + 1).map((count) => {
          const on = value === count;
          return (
            <button
              key={count}
              type="button"
              aria-pressed={on}
              aria-label={t('ticketCount', { count })}
              onClick={() => onChange(on ? null : count)}
              className={`flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md border px-2.5 text-[0.9375rem] font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:transition-colors ${
                on
                  ? 'border-action-primary bg-action-primary text-action-primary-foreground'
                  : 'border-border-input bg-background-surface text-text-primary hover:border-action-primary hover:bg-tint-primary'
              }`}
            >
              {count}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-caption text-text-muted" aria-live="polite">
        {value === null
          ? t('tapToAdd')
          : value === 1
            ? t('ticketHintOne')
            : t('ticketHintMany', { count: value })}
      </p>
    </div>
  );
}
