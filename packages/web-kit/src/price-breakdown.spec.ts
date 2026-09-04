import { describe, it, expect } from 'vitest';
import { priceBreakdown, type BreakdownQuote } from './price-breakdown';

/**
 * The rows a buyer can see must add up to the total they are charged.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 * That invariant has been broken twice, both times by rendering tax that was already
 * inside the price as though it were being added to it. The receipt did it and a customer
 * spotted it; the storefront did it and only an assertion caught it, on a cart that came
 * to ₹400.98 in visible rows against a ₹355.22 total.
 *
 * A test that checks labels would have passed both times. The one below adds the numbers up.
 */
const quote = (over: Partial<BreakdownQuote> = {}): BreakdownQuote => ({
  subtotalMinor: 30_000,
  discountMinor: 0,
  bookingFeeMinor: 4_000,
  paymentFeeMinor: 680,
  customerFeeInclusiveMinor: 5_522,
  customerFeeMinor: 4_680,
  feeTaxRateBasisPoints: 1_800,
  taxLines: [],
  totalMinor: 35_522,
  ...over,
});

/** The assertion the whole file is for. */
const foots = (q: BreakdownQuote) => {
  const b = priceBreakdown(q);
  return b.rows.reduce((sum, r) => sum + r.amountMinor, 0) === b.totalMinor;
};

const CGST = { label: 'CGST', rateBasisPoints: 900, amountMinor: 2_288, basis: 'TICKETS' } as const;
const SGST = { label: 'SGST', rateBasisPoints: 900, amountMinor: 2_288, basis: 'TICKETS' } as const;
const FEE_IGST = {
  label: 'IGST',
  rateBasisPoints: 1_800,
  amountMinor: 842,
  basis: 'FEES',
} as const;

describe('the rows foot', () => {
  it('with no tax at all — the default that ships', () => {
    expect(
      foots(quote({ taxLines: [], customerFeeInclusiveMinor: 4_680, totalMinor: 34_680 })),
    ).toBe(true);
  });

  it('with INCLUSIVE ticket tax — the case that was wrong twice', () => {
    /*
      ₹300 of tickets with 18% GST already inside them, plus a ₹46.80 fee with 18% added.
      The GST rows must NOT be part of the sum; counting them gave ₹400.98 against ₹355.22.
    */
    expect(
      foots(
        quote({
          taxLines: [
            { ...CGST, inclusive: true },
            { ...SGST, inclusive: true },
            { ...FEE_IGST, inclusive: false },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('with ADDED ticket tax — a US-style sales tax genuinely on top', () => {
    // The other model, and the reason inclusive tax could not simply be dropped for everyone.
    expect(
      foots(
        quote({
          taxLines: [
            {
              label: 'Sales tax',
              rateBasisPoints: 1_000,
              amountMinor: 3_468,
              basis: 'TICKETS',
              inclusive: false,
            },
          ],
          customerFeeInclusiveMinor: 4_680,
          totalMinor: 38_148,
        }),
      ),
    ).toBe(true);
  });

  it('with a discount, which has to subtract', () => {
    expect(
      foots(quote({ discountMinor: 5_000, customerFeeInclusiveMinor: 4_680, totalMinor: 29_680 })),
    ).toBe(true);
  });
});

describe('what goes where', () => {
  const b = priceBreakdown(
    quote({
      taxLines: [
        { ...CGST, inclusive: true },
        { ...SGST, inclusive: true },
        { ...FEE_IGST, inclusive: false },
      ],
    }),
  );

  it('puts inclusive ticket tax BELOW the total, not among the rows', () => {
    expect(b.rows.some((r) => r.kind === 'tax')).toBe(false);
    expect(b.includedTax.map((t) => t.label)).toEqual(['CGST', 'SGST']);
  });

  it('never lists the FEE’s tax in either place — it is inside the fee row', () => {
    // Stating it again would show the same rupees twice, once folded into the fee and once
    // on its own line.
    expect(b.rows.some((r) => r.label === 'IGST')).toBe(false);
    expect(b.includedTax.some((t) => t.label === 'IGST')).toBe(false);
  });

  it('shows ONE platform-fee row, all-in, and names the rate inside it', () => {
    const fee = b.rows.filter((r) => r.kind === 'platformFee');
    expect(fee).toHaveLength(1);
    expect(fee[0].amountMinor).toBe(5_522);
    expect(b.platformFeeRateBasisPoints).toBe(1_800);
  });
});

describe('an older API that does not send the new fields', () => {
  it('adds the two fee components when there is no all-in figure', () => {
    const b = priceBreakdown(
      quote({
        customerFeeInclusiveMinor: undefined,
        customerFeeMinor: undefined,
        feeTaxRateBasisPoints: undefined,
        totalMinor: 34_680,
      }),
    );
    expect(b.rows.find((r) => r.kind === 'platformFee')?.amountMinor).toBe(4_680);
    expect(b.platformFeeRateBasisPoints).toBe(0);
  });

  it('treats a tax line with no `inclusive` flag as ADDED, which is what it was', () => {
    /*
      Absent must mean "added", because that is how every quote behaved before the flag
      existed. Guessing "inclusive" would move a real charge below the total and understate
      what the rows come to.
    */
    const b = priceBreakdown(quote({ taxLines: [CGST], totalMinor: 32_288 + 5_522 - 2_288 }));
    expect(b.includedTax).toHaveLength(0);
    expect(b.rows.some((r) => r.label === 'CGST')).toBe(true);
  });
});

describe('a statutory maintenance charge', () => {
  /*
    The third money component, and the one most likely to be double-counted: it is the only
    one whose amount is DISCLOSED even when it changes nothing about the total.
  */
  const withMaintenance = (minor: number, treatment: BreakdownQuote['maintenanceTreatment']) =>
    quote({
      maintenanceMinor: minor,
      maintenanceTreatment: treatment,
      customerFeeInclusiveMinor: 4_680,
      // Added: the ticket subtotal plus the fee plus the charge. Included: no charge on top.
      totalMinor: treatment === 'ADDED_TO_TICKET_PRICE' ? 30_000 + 4_680 + minor : 30_000 + 4_680,
    });

  it('is its own row, and foots, when the charge is ADDED', () => {
    const q = withMaintenance(1_000, 'ADDED_TO_TICKET_PRICE');
    const b = priceBreakdown(q);
    expect(b.rows.filter((r) => r.kind === 'maintenance')).toHaveLength(1);
    expect(b.rows.reduce((s, r) => s + r.amountMinor, 0)).toBe(b.totalMinor);
  });

  it('is NOT a row, and still foots, when the charge is INCLUDED', () => {
    /*
      The double-charge. The amount is already inside the ticket price the customer is
      paying — listing it above the total asks them to add it twice and produces a column
      that does not foot, which is exactly the defect inclusive TAX has produced twice on
      this platform already.
    */
    const q = withMaintenance(1_000, 'INCLUDED_IN_TICKET_PRICE');
    const b = priceBreakdown(q);
    expect(b.rows.some((r) => r.kind === 'maintenance')).toBe(false);
    expect(b.includedMaintenanceMinor).toBe(1_000);
    expect(b.rows.reduce((s, r) => s + r.amountMinor, 0)).toBe(b.totalMinor);
  });

  it('is still DISCLOSED when included, because an invoice has to state it', () => {
    // Not rendered is not the same as not charged. It was charged — inside the price.
    expect(
      priceBreakdown(withMaintenance(1_000, 'INCLUDED_IN_TICKET_PRICE')).includedMaintenanceMinor,
    ).toBe(1_000);
  });

  it('appears nowhere at all when no policy applies', () => {
    // Every non-cinema event, and every market with no order written for it.
    const b = priceBreakdown(quote({ customerFeeInclusiveMinor: 4_680, totalMinor: 34_680 }));
    expect(b.rows.some((r) => r.kind === 'maintenance')).toBe(false);
    expect(b.includedMaintenanceMinor).toBe(0);
  });

  it('foots alongside an inclusive ticket tax, which is the real Indian cart', () => {
    // Both an included charge AND an inclusive tax: two amounts disclosed, neither added.
    const q = quote({
      maintenanceMinor: 1_000,
      maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
      taxLines: [
        {
          label: 'CGST',
          rateBasisPoints: 900,
          amountMinor: 2_288,
          basis: 'TICKETS',
          inclusive: true,
        },
      ],
      customerFeeInclusiveMinor: 4_680,
      totalMinor: 34_680,
    });
    const b = priceBreakdown(q);
    expect(b.rows.reduce((s, r) => s + r.amountMinor, 0)).toBe(b.totalMinor);
    expect(b.includedMaintenanceMinor).toBe(1_000);
    expect(b.includedTax).toHaveLength(1);
  });
});
