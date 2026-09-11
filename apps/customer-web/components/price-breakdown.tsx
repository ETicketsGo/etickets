'use client';

import { useId, useState } from 'react';
import { money } from '@/lib/format';
import { useTranslations } from 'next-intl';
import { priceBreakdown, moneyFractionDigits, type BreakdownTaxLine } from '@eticketsgo/web-kit';

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
 * one of these now, and the event page, seat map, payment, confirmation and booking details
 * all use it.
 *
 * ── WHERE THE NUMBERS COME FROM ────────────────────────────────────────────────────
 * `POST /bookings/quote`, which prices the cart with the same code the booking itself uses
 * and holds nothing — or the booking's own snapshot once it exists. A breakdown computed on
 * the client would be a second implementation of fee tiers and tax, and the first time the
 * two disagreed the customer would be the one to find out.
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
  /** The customer's fees all-in. Falls back to booking + payment fee on an older API. */
  customerFeeInclusiveMinor?: number;
  customerFeeMinor?: number;
  /** The combined rate on the fees — 1800 for 18%, 0 when untaxed. */
  feeTaxRateBasisPoints?: number;
  feeTaxMinor?: number;
  /** A statutory per-ticket charge; disclosed with the tickets when it is already included. */
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

function Line({
  label,
  value,
  muted,
  hint,
}: {
  label: string;
  value: string;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-[0.9375rem]">
      <span className={muted ? 'text-text-muted' : 'text-text-secondary'}>
        <span>{label}</span>
        {hint ? <span className="block text-caption text-text-muted">{hint}</span> : null}
      </span>
      <span className="tabular-nums text-text-primary">{value}</span>
    </div>
  );
}

/**
 * The tickets, and the tax already inside their price.
 *
 * ── WHY THE TAX LIVES HERE, FOLDED ─────────────────────────────────────────────────
 * It sat below the total as "Includes CGST (9%) ₹38.06". Correct, and still read as a
 * charge: it was the last money on the screen, after the number the buyer was agreeing to.
 * Reported from QA — it belongs with the ticket price it is part of, and a buyer who wants it
 * can open it.
 *
 * Closed by default: the ticket price already contains it, so it changes nothing about what
 * is paid. The panel stays in the DOM, hidden, so its toggle always points at something real.
 */
function TicketsLine({
  label,
  value,
  included,
  includedMaintenanceMinor,
  currency,
  digits,
}: {
  label: string;
  value: string;
  included: BreakdownTaxLine[];
  includedMaintenanceMinor: number;
  currency?: string;
  digits?: number;
}) {
  const t = useTranslations('storefront.event');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const hasDetail = included.length > 0 || includedMaintenanceMinor > 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-4 text-[0.9375rem]">
        <span className="flex flex-wrap items-center gap-x-2 text-text-secondary">
          <span>{label}</span>
          {hasDetail && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={panelId}
              className="rounded text-caption text-brand-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
            >
              {open ? t('taxDetailsHide') : t('taxDetailsShow')}
            </button>
          )}
        </span>
        <span className="tabular-nums text-text-primary">{value}</span>
      </div>
      {hasDetail && (
        <div
          id={panelId}
          hidden={!open}
          data-testid="included-tax"
          className="mt-1 space-y-1 border-l-2 border-border pl-3"
        >
          {included.map((tax) => (
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
          {includedMaintenanceMinor > 0 && (
            <Line
              muted
              label={t('maintenanceIncluded')}
              value={money(includedMaintenanceMinor, currency, undefined, digits)}
            />
          )}
          <p className="text-caption text-text-muted">{t('taxIncludedNote')}</p>
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
  /**
   * What to price in before a quote exists.
   *
   * ── WHY THIS IS A PROP AND NOT A DEFAULT ───────────────────────────────────────────
   * The currency came from the quote alone, so an empty cart had none — and `money()` falls
   * back to INR when it is not told otherwise. A seat map for a cinema in Boise therefore
   * opened on "Total (0 seats) ₹0", switched to dollars the moment a seat was picked, and
   * switched back the moment the last one was removed.
   */
  fallbackCurrency,
  /**
   * Replaces "this is the final price" once a quote exists; `null` shows nothing.
   *
   * That sentence is a promise about money not yet taken. On a confirmation, where the money
   * HAS been taken, it answers a question nobody is asking.
   */
  note,
}: {
  quote?: QuotedFees | null;
  loading?: boolean;
  fallbackTotalMinor?: number;
  totalLabel?: string;
  emptyNote?: string;
  free?: boolean;
  fallbackCurrency?: string;
  note?: string | null;
}) {
  const t = useTranslations('storefront.event');
  // The quote still wins whenever there is one: it is what the buyer will be charged in.
  const currency = quote?.currency ?? fallbackCurrency;

  /*
    The arithmetic lives in `@eticketsgo/web-kit` and is unit-tested there, because the one
    thing this component must never get wrong is a number. The rule it enforces: the rows
    rendered above the total add up to the total.
  */
  const breakdown = quote ? priceBreakdown(quote) : null;

  /*
    One number of decimals for the whole breakdown, decided from the amounts in it.

    Deciding per row prints "₹300" above "₹55.22", where the decimal points do not line up
    and the first row reads as a different kind of number from the second.
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
      {breakdown ? (
        <div className="space-y-1" data-testid="price-breakdown">
          {breakdown.rows.map((row) => {
            const value =
              row.amountMinor < 0
                ? `- ${money(-row.amountMinor, currency, undefined, digits)}`
                : money(row.amountMinor, currency, undefined, digits);
            const key = `${row.kind}-${row.label ?? ''}-${row.rateBasisPoints ?? ''}`;

            if (row.kind === 'tickets') {
              return (
                <TicketsLine
                  key={key}
                  label={t('lineTickets')}
                  value={value}
                  included={breakdown.includedTax}
                  includedMaintenanceMinor={breakdown.includedMaintenanceMinor}
                  currency={currency}
                  digits={digits}
                />
              );
            }
            /*
              Payment processing says who charges it. Folded into "Platform fee" it read as
              money the platform keeps — the reported complaint — when it is what the card or
              UPI network charges to move the payment.
            */
            if (row.kind === 'paymentFee') {
              return (
                <Line
                  key={key}
                  label={t('feePaymentPart')}
                  hint={t('paymentFeeHint')}
                  value={value}
                />
              );
            }
            /*
              A lookup rather than a nested ternary: the thing deciding what a customer is shown
              should stay readable, because unreadable is how the wrong label ends up on the
              wrong number.
            */
            const LABELS: Record<string, () => string> = {
              discount: () => t('lineDiscount'),
              // A statutory charge, and its own row only when it is ADDED — an included one is
              // disclosed with the tickets instead, because it is already in the price.
              maintenance: () => t('maintenanceCharge'),
              platformFee: () => t('platformFee'),
              feeTax: () =>
                (row.rateBasisPoints ?? 0) > 0
                  ? t('feeTaxPart', { rate: `${ratePercent(row.rateBasisPoints ?? 0)}%` })
                  : t('feeTaxNoRate'),
              fees: () => t('feesCombined'),
            };
            const label =
              LABELS[row.kind]?.() ?? `${row.label} (${ratePercent(row.rateBasisPoints ?? 0)}%)`;
            return <Line key={key} label={label} value={value} />;
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
      {quote && note === null ? null : (
        <p className="mt-1 text-caption text-text-muted">
          {/*
            Three different states, three different sentences. The old copy said the same
            apologetic thing in all of them, which meant it was wrong in the one case that
            matters — when we DO know the full amount and could simply say so.
          */}
          {quote
            ? (note ?? t('priceIsFinal'))
            : loading
              ? t('priceWorking')
              : (emptyNote ?? t('priceAddOne'))}
        </p>
      )}
    </div>
  );
}
