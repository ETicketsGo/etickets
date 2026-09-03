'use client';

import { money } from '@/lib/format';
import { useTranslations } from 'next-intl';

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
    All-in when the API supplies it, and the two fee components added together when it does
    not — an older API is still correct, just without the tax folded in.
  */
  const platformFeeMinor =
    quote?.customerFeeInclusiveMinor ??
    quote?.customerFeeMinor ??
    (quote ? quote.bookingFeeMinor + quote.paymentFeeMinor : 0);
  const feeRate = quote?.feeTaxRateBasisPoints ?? 0;

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
          <Line label={t('lineTickets')} value={money(quote.subtotalMinor, currency)} />
          {quote.discountMinor > 0 && (
            <Line label={t('lineDiscount')} value={`- ${money(quote.discountMinor, currency)}`} />
          )}
          {/*
            ── ONE ROW FOR WHAT THE PLATFORM COSTS ────────────────────────────────────
            The booking fee, the payment fee and the tax charged on them were three separate
            lines. None of them answers the question a customer is actually asking, and
            adding three numbers to find out is work we were handing them.

            So it is one row, and the label says what is inside it — "Platform fee (incl. 18%
            GST)". The itemised tax lines below the total still carry the rate and the taxable
            value, because an invoice needs those and a customer does not.
          */}
          {platformFeeMinor > 0 && (
            <Line
              label={
                feeRate > 0
                  ? t('platformFeeInclusive', { rate: `${ratePercent(feeRate)}%` })
                  : t('platformFee')
              }
              value={money(platformFeeMinor, currency)}
            />
          )}
          {/*
            Tax on the FEE is already stated in the fee row above, so listing it again here
            would show the same rupees twice. Tax on the TICKETS still needs itemising.

            Filtered on `basis`, which the API states — comparing amounts to work out which
            line was the fee's is a guess, and it is wrong the moment two lines happen to be
            equal. An older API sends no basis and everything is listed, as before.
          */}
          {(quote.taxLines ?? [])
            .filter((tax) => tax.basis !== 'FEES')
            .map((tax) => (
              <Line
                key={`${tax.label}-${tax.rateBasisPoints}`}
                label={`${tax.label} (${ratePercent(tax.rateBasisPoints)}%)`}
                value={money(tax.amountMinor, currency)}
              />
            ))}
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
