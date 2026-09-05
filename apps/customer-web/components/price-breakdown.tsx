'use client';

import { useState } from 'react';
import { money } from '@/lib/format';
import { useTranslations } from 'next-intl';
import { priceBreakdown, moneyFractionDigits } from '@eticketsgo/web-kit';

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
  /** A statutory per-ticket charge; disclosed below the total when it is already included. */
  maintenanceMinor?: number;
  maintenanceTreatment?:
    'NOT_APPLICABLE' | 'INCLUDED_IN_TICKET_PRICE' | 'ADDED_TO_TICKET_PRICE' | 'UNCONFIRMED';
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

/**
 * The platform fee, and what it is made of when somebody asks.
 *
 * Collapsed by default: the answer to "what does this cost me" is one number, and a
 * checkout that itemises everything by default is one a buyer stops reading. Open, it names
 * where each part goes — which is the actual question behind "why is there a fee".
 */
function PlatformFeeLine({
  label,
  value,
  parts,
  rateBasisPoints,
  currency,
  digits,
}: {
  label: string;
  value: string;
  parts: { bookingFeeMinor: number; paymentFeeMinor: number; taxMinor: number };
  rateBasisPoints: number;
  currency?: string;
  digits?: number;
}) {
  const t = useTranslations('storefront.event');
  const [open, setOpen] = useState(false);
  const money2 = (m: number) => money(m, currency, undefined, digits);

  return (
    <div>
      <div className="flex items-center justify-between gap-4 text-[0.9375rem]">
        <span className="flex items-center gap-2 text-text-secondary">
          {label}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded text-caption text-brand-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
          >
            {open ? t('feeBreakdownHide') : t('feeBreakdownShow')}
          </button>
        </span>
        <span className="tabular-nums text-text-primary">{value}</span>
      </div>
      {open && (
        <div className="mt-1 space-y-1 border-l-2 border-border pl-3">
          {parts.bookingFeeMinor > 0 && (
            <Line muted label={t('feeBookingPart')} value={money2(parts.bookingFeeMinor)} />
          )}
          {parts.paymentFeeMinor > 0 && (
            <Line muted label={t('feePaymentPart')} value={money2(parts.paymentFeeMinor)} />
          )}
          {/* Only when the fee is actually taxed. A 0% line is noise pretending to be rigour. */}
          {parts.taxMinor > 0 && (
            <Line
              muted
              label={t('feeTaxPart', { rate: `${ratePercent(rateBasisPoints)}%` })}
              value={money2(parts.taxMinor)}
            />
          )}
          <p className="text-caption text-text-muted">{t('feeBreakdownNote')}</p>
        </div>
      )}
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

  /*
    One number of decimals for the whole breakdown, decided from the amounts in it.

    Deciding per row prints "₹300" above "₹55.22", where the decimal points do not line up
    and the first row reads as a different kind of number from the second. Whole-rupee carts
    — which is most of them — still show ₹300 and ₹350 with no trailing noise.
  */
  const digits = breakdown
    ? moneyFractionDigits(
        [...breakdown.rows.map((r) => r.amountMinor), breakdown.totalMinor],
        currency,
      )
    : undefined;

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
            const LABELS: Record<string, () => string> = {
              tickets: () => t('lineTickets'),
              discount: () => t('lineDiscount'),
              // A statutory charge, and its own row only when it is ADDED — an included one
              // is disclosed below the total instead, because it is already in the price.
              maintenance: () => t('maintenanceCharge'),
              platformFee: () =>
                breakdown!.platformFeeRateBasisPoints > 0
                  ? t('platformFeeInclusive', {
                      rate: `${ratePercent(breakdown!.platformFeeRateBasisPoints)}%`,
                    })
                  : t('platformFee'),
            };
            /*
              A lookup rather than a fifth nested ternary. The chain was already three deep
              and this row would have made it four — at which point the thing deciding what a
              customer is shown becomes unreadable, and unreadable is how the wrong label ends
              up on the wrong number.
            */
            const label =
              LABELS[row.kind]?.() ?? `${row.label} (${ratePercent(row.rateBasisPoints ?? 0)}%)`;
            const value =
              row.amountMinor < 0
                ? `- ${money(-row.amountMinor, currency, undefined, digits)}`
                : money(row.amountMinor, currency, undefined, digits);

            /*
              The platform fee stays ONE row and gains a way to open it.

              Three lines hand the customer arithmetic; one line with no explanation asks them
              to trust a number. The parts go to genuinely different places — the booking fee
              is ours, the payment fee is what the card or UPI network charges — and a buyer
              who wants to know that should not have to ask support.
            */
            if (row.kind === 'platformFee') {
              return (
                <PlatformFeeLine
                  key="platformFee"
                  label={label}
                  value={value}
                  parts={breakdown!.platformFee}
                  rateBasisPoints={breakdown!.platformFeeRateBasisPoints}
                  currency={currency}
                  digits={digits}
                />
              );
            }
            return (
              <Line
                key={`${row.kind}-${row.label ?? ''}-${row.rateBasisPoints ?? ''}`}
                label={label}
                value={value}
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
          {money(quote ? quote.totalMinor : (fallbackTotalMinor ?? 0), currency, undefined, digits)}
        </span>
      </div>
      {/*
        An INCLUDED maintenance charge is disclosed here, never added above. It is already
        inside the ticket price — listing it as a row would ask the customer to add it a
        second time and produce a column that does not foot.
      */}
      {breakdown && breakdown.includedMaintenanceMinor > 0 && (
        <div className="mt-2">
          <Line
            muted
            label={t('maintenanceIncluded')}
            value={money(breakdown.includedMaintenanceMinor, currency, undefined, digits)}
          />
        </div>
      )}
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
              value={money(tax.amountMinor, currency, undefined, digits)}
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
