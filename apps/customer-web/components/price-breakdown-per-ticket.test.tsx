// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor } from '@eticketsgo/i18n';
import { PriceBreakdown, type QuotedFees } from './price-breakdown';

/*
  Owner decision 2026-10-29: a FIXED_PER_TICKET platform fee is explained under its line as
  "Rs 5.00 per ticket, for 3 tickets" - but only when that sentence is the whole story. When a
  minimum or maximum changed the fee, the line reads as any other fee does.
*/

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(quote: QuotedFees, locale: string = DEFAULT_LOCALE) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <NextIntlClientProvider locale={locale} messages={messagesFor(locale as never)}>
        <PriceBreakdown quote={quote} />
      </NextIntlClientProvider>,
    ),
  );
  return host.textContent ?? '';
}

const BASE: QuotedFees = {
  currency: 'INR',
  subtotalMinor: 300_000,
  discountMinor: 0,
  bookingFeeMinor: 1_500,
  paymentFeeMinor: 0,
  customerFeeMinor: 1_500,
  totalMinor: 301_500,
  platformFeeBreakdown: {
    type: 'FIXED_PER_TICKET',
    percentBps: 0,
    fixedPerTicketMinor: 500,
    ticketCount: 3,
    percentPartMinor: 0,
    fixedPartMinor: 1_500,
  },
};

describe('PriceBreakdown with a FIXED_PER_TICKET platform fee', () => {
  it('explains the fee: Rs 5 per ticket, for 3 tickets', () => {
    const text = render(BASE);
    // Whole rupees print without paise, as every price on the storefront does.
    expect(text).toMatch(/₹5 per ticket, for 3 tickets/);
  });

  it('says "1 ticket" for one', () => {
    const text = render({
      ...BASE,
      bookingFeeMinor: 500,
      customerFeeMinor: 500,
      totalMinor: 100_500,
      subtotalMinor: 100_000,
      platformFeeBreakdown: { ...BASE.platformFeeBreakdown!, ticketCount: 1, fixedPartMinor: 500 },
    });
    expect(text).toMatch(/₹5 per ticket, for 1 ticket(?!s)/);
  });

  it('shows no terms when a minimum changed the fee', () => {
    const text = render({
      ...BASE,
      bookingFeeMinor: 2_000,
      customerFeeMinor: 2_000,
      totalMinor: 302_000,
      platformFeeBreakdown: {
        ...BASE.platformFeeBreakdown!,
        minFeeMinor: 2_000,
        maxFeeMinor: null,
        limitApplied: 'MIN',
      },
    });
    expect(text).not.toMatch(/per ticket/);
  });

  it('is translated for fr-CA', () => {
    const text = render(BASE, 'fr-CA');
    expect(text).toMatch(/par billet, pour 3 billets/);
  });
});
