'use client';

import { money } from '@/lib/format';
import { useTranslations } from 'next-intl';
import { priceBreakdown } from '@eticketsgo/web-kit';

/**
 * What the buyer will actually be charged, itemised, before they commit to anything.
 *
 * ── WHY THIS IS A COMPONENT AND NOT A BLOCK OF JSX IN ONE PAGE ─────────────────────
 * It was a block of JSX in one page. The seat-picking screen got a real breakdown; the
 * ordinary event page — which is most of what this platform sells — kept the line
 * "Transparent fees shown on the next step", which is an apology for showing somebody a
 * number that is not what they will pay. On QA that gap was ₹998 advertised against
 * ₹1,033.26 payable: a booking fee and a payment fee the buyer met one screen later.
 *
 * Two screens showing the same money in two ways is how they come to disagree, so there is
 * one of these now and both use it.
 *
 * ── WHERE THE NUMBERS COME FROM ────────────────────────────────────────────────────
 * `POST /bookings/quote`, which prices the cart with the same code the booking itself uses
 * and holds nothing. That matters more than it sounds: a breakdown computed on the client
 * would be a second implementation of fee tiers and tax, and the first time the two
 * disagreed the customer would be the one to find out.
 *
 * The currency comes from the quote rather than from a default. `money()` falls back to INR
 * when it is not told otherwise, so a total rendered without it is correct only for as long
 * as every event is priced in rupees.
 */
export interface QuotedFees {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  /** The platform fee all-in. Falls back to booking + payment fee on an older API. */
  customerFeeInclusiveMinor?: number;
  customerFeeMinor?: number;
  /** The combined rate inside the all-in fee — 1800 for 18%, 0 when untaxed. */
  feeTaxRateBasisPoints?: number;
  feeTaxMinor?: number;
  taxLines?: {
    label: string;
    rateBasisPoints: number;
    amountMinor: number;
    /** What the line was levied on. Absent on an older API, which lists everything. */
    basis?: 'TICKETS' | 'FEES' | 'TICKETS_AND_FEES';
    /** Whether the tax was already inside the price rather than added to it. */
    inclusive?: boolean;
  }[];
  totalMinor: number;
}

/** A tax rate reads as a percentage, and only carries decimals when it has them. */
function ratePercent(basisPoints: number): string {
  return (basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2);
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[0.9375rem]">
      <span className={muted ? 'text-text-muted' : 'text-text-secondary'}>{label}</span>
      <span className="tabular-nums text-text-primary">{value}</span>
    </div>
  );
}

export function PriceBreakdown({
  quote,
  /** Shown in place of the total while a fresh quote is in flight. */
  loading = false,
  /** The total to show before any quote exists — the bare ticket subtotal. */
  fallbackTotalMinor,
  /** Overrides the total's label, e.g. "Total (2 seats)". */
  totalLabel,
  /** Told to the buyer when there is nothing to price yet. */
  emptyNote,
  /** A free event has no money to break down; the caller says so rather than us guessing. */
  free = false,
}: {
  quote?: QuotedFees | null;
  loading?: boolean;
  fallbackTotalMinor?: number;
  totalLabel?: string;
  emptyNote?: string;
  free?: boolean;
}) {
  const t = useTranslations('storefront.event');
  const currency = quote?.currency;

  /*
    The arithmetic lives in `@eticketsgo/web-kit` and is unit-tested there, because the one
    thing this component must never get wrong is a number. The rule it enforces: the rows
    rendered above the total add up to the total. That has been broken twice — both times by
    showing tax that was already inside the price as though it were being added — and a test
    that checked labels would have passed on both occasions.
  */
  const breakdown = quote ? priceBreakdown(quote) : null;

  if (free) {
    return (
      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[0.9375rem] text-text-secondary">{totalLabel ?? t('total')}</span>
          <span className="text-title font-bold text-text-primary">{t('freeLabel')}</span>
        </div>
        <p className="mt-1 text-caption text-text-muted">{t('freeNote')}</p>
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-4">
      {quote ? (
        <div className="space-y-1" data-testid="price-breakdown">
          {breakdown!.rows.map((row) => {
            /*
              One row for what the platform costs, not three. The booking fee, the payment
              fee and the tax on them were separate lines; none of the three answers what a
              buyer is asking, and adding them up was work being handed to the customer.
            */
            const label =
              row.kind === 'tickets'
                ? t('lineTickets')
                : row.kind === 'discount'
                  ? t('lineDiscount')
                  : row.kind === 'platformFee'
                    ? breakdown!.platformFeeRateBasisPoints > 0
                      ? t('platformFeeInclusive', {
                          rate: `${ratePercent(breakdown!.platformFeeRateBasisPoints)}%`,
                        })
                      : t('platformFee')
                    : `${row.label} (${ratePercent(row.rateBasisPoints ?? 0)}%)`;
            return (
              <Line
                key={`${row.kind}-${row.label ?? ''}-${row.rateBasisPoints ?? ''}`}
                label={label}
                value={
                  row.amountMinor < 0
                    ? `- ${money(-row.amountMinor, currency)}`
                    : money(row.amountMinor, currency)
                }
              />
            );
          })}
        </div>
      ) : null}

      <div
        className={`flex items-center justify-between ${quote ? 'mt-2 border-t border-border pt-2' : ''}`}
      >
        <span className="text-[0.9375rem] text-text-secondary">{totalLabel ?? t('total')}</span>
        {/* Addressable on its own: the amount the buyer is agreeing to is the one thing
            worth being able to point at exactly, from a test or from anywhere else. */}
        <span
          data-testid="price-total"
          className="text-title font-bold tabular-nums text-text-primary"
        >
          {money(quote ? quote.totalMinor : (fallbackTotalMinor ?? 0), currency)}
        </span>
      </div>
      {breakdown && breakdown.includedTax.length > 0 && (
        <div className="mt-2 space-y-1">
          {breakdown.includedTax.map((tax) => (
            <Line
              key={`incl-${tax.label}-${tax.rateBasisPoints}`}
              muted
              label={t('taxIncluded', {
                label: tax.label,
                rate: `${ratePercent(tax.rateBasisPoints)}%`,
              })}
              value={money(tax.amountMinor, currency)}
            />
          ))}
          <p className="text-caption text-text-muted">{t('taxIncludedNote')}</p>
        </div>
      )}
      <p className="mt-1 text-caption text-text-muted">
        {/*
          Three different states, three different sentences. The old copy said the same
          apologetic thing in all of them, which meant it was wrong in the one case that
          matters — when we DO know the full amount and could simply say so.
        */}
        {quote ? t('priceIsFinal') : loading ? t('priceWorking') : (emptyNote ?? t('priceAddOne'))}
      </p>
    </div>
  );
}
