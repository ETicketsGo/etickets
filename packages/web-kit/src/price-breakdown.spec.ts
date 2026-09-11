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

  /*
    Reported from QA: one "Platform fee (incl. 18% GST)" row that contained the payment fee
    read as money the platform keeps. Payment processing is the card or UPI network's charge.
  */
  it('lists payment processing, the platform fee and the tax on them as separate rows', () => {
    expect(b.rows.map((r) => [r.kind, r.amountMinor])).toEqual([
      ['tickets', 30_000],
      ['paymentFee', 680],
      ['platformFee', 4_000],
      ['feeTax', 842],
    ]);
    expect(b.rows.find((r) => r.kind === 'feeTax')?.rateBasisPoints).toBe(1_800);
  });
});

describe('a booking read back without the all-in fee', () => {
  /*
    Reported from QA: Review & pay showed ₹499 + ₹10.18 + ₹10 under "Total payable ₹522.82".
    The booking gave the fee before tax and its tax lines, but not the all-in figure the quote
    gives, so the GST on the fees had no row.
  */
  const bookingShaped: BreakdownQuote = {
    subtotalMinor: 49_900,
    discountMinor: 0,
    bookingFeeMinor: 1_000,
    paymentFeeMinor: 1_018,
    customerFeeMinor: 2_018,
    taxLines: [
      {
        label: 'CGST',
        rateBasisPoints: 900,
        amountMinor: 3_806,
        basis: 'TICKETS',
        inclusive: true,
      },
      {
        label: 'SGST',
        rateBasisPoints: 900,
        amountMinor: 3_806,
        basis: 'TICKETS',
        inclusive: true,
      },
      { label: 'CGST', rateBasisPoints: 900, amountMinor: 182, basis: 'FEES', inclusive: false },
      { label: 'SGST', rateBasisPoints: 900, amountMinor: 182, basis: 'FEES', inclusive: false },
    ],
    totalMinor: 52_282,
  };

  it('rebuilds the GST on the fees from the tax lines, so the rows reach the total', () => {
    const b = priceBreakdown(bookingShaped);
    expect(b.rows.map((r) => [r.kind, r.amountMinor])).toEqual([
      ['tickets', 49_900],
      ['paymentFee', 1_018],
      ['platformFee', 1_000],
      ['feeTax', 364],
    ]);
    expect(b.rows.find((r) => r.kind === 'feeTax')?.rateBasisPoints).toBe(1_800);
    expect(foots(bookingShaped)).toBe(true);
  });

  it('matches what the checkout quote shows for the same order', () => {
    const quoted = priceBreakdown({
      ...bookingShaped,
      customerFeeInclusiveMinor: 2_382,
      feeTaxRateBasisPoints: 1_800,
    });
    expect(priceBreakdown(bookingShaped).rows).toEqual(quoted.rows);
  });
});

describe('the fees, divided', () => {
  it('reproduces the QA cart line for line: ₹499 + ₹10.18 + ₹10 + ₹3.64 = ₹522.82', () => {
    const q: BreakdownQuote = {
      subtotalMinor: 49_900,
      discountMinor: 0,
      bookingFeeMinor: 1_000,
      paymentFeeMinor: 1_018,
      customerFeeMinor: 2_018,
      customerFeeInclusiveMinor: 2_382,
      feeTaxRateBasisPoints: 1_800,
      taxLines: [
        {
          label: 'CGST',
          rateBasisPoints: 900,
          amountMinor: 3_806,
          basis: 'TICKETS',
          inclusive: true,
        },
        {
          label: 'SGST',
          rateBasisPoints: 900,
          amountMinor: 3_806,
          basis: 'TICKETS',
          inclusive: true,
        },
        { label: 'CGST', rateBasisPoints: 900, amountMinor: 182, basis: 'FEES', inclusive: false },
        { label: 'SGST', rateBasisPoints: 900, amountMinor: 182, basis: 'FEES', inclusive: false },
      ],
      totalMinor: 52_282,
    };
    const b = priceBreakdown(q);
    expect(b.rows.map((r) => [r.kind, r.amountMinor])).toEqual([
      ['tickets', 49_900],
      ['paymentFee', 1_018],
      ['platformFee', 1_000],
      ['feeTax', 364],
    ]);
    expect(foots(q)).toBe(true);
    // The ticket GST is disclosed with the tickets — inside their price, never a row.
    expect(b.includedTax.map((t) => [t.label, t.amountMinor])).toEqual([
      ['CGST', 3_806],
      ['SGST', 3_806],
    ]);
  });

  it('divides the customer’s SHARE of the fees when the organizer covers the rest', () => {
    // The booking carries the full ₹31.28 of fees; the customer pays ₹15.64 of it plus tax.
    const q = quote({
      bookingFeeMinor: 1_500,
      paymentFeeMinor: 1_628,
      customerFeeMinor: 1_564,
      customerFeeInclusiveMinor: 1_846,
      totalMinor: 30_000 + 1_846,
    });
    const b = priceBreakdown(q);
    const fees = b.rows.filter((r) => r.kind !== 'tickets');
    expect(fees.map((r) => r.kind)).toEqual(['paymentFee', 'platformFee', 'feeTax']);
    expect(fees.reduce((s, r) => s + r.amountMinor, 0)).toBe(1_846);
    expect(foots(q)).toBe(true);
  });

  it('keeps the fees as ONE row rather than guessing, when only the all-in figure is known', () => {
    const q = quote({ customerFeeMinor: undefined, customerFeeInclusiveMinor: 5_522 });
    const b = priceBreakdown(q);
    expect(b.rows.map((r) => r.kind)).toEqual(['tickets', 'fees']);
    expect(foots(q)).toBe(true);
  });

  it('shows no fee rows at all when the customer is charged none', () => {
    const q = quote({
      customerFeeMinor: 0,
      customerFeeInclusiveMinor: 0,
      feeTaxRateBasisPoints: 0,
      totalMinor: 30_000,
    });
    expect(priceBreakdown(q).rows.map((r) => r.kind)).toEqual(['tickets']);
    expect(foots(q)).toBe(true);
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
    expect(b.rows.find((r) => r.kind === 'paymentFee')?.amountMinor).toBe(680);
    expect(b.rows.find((r) => r.kind === 'platformFee')?.amountMinor).toBe(4_000);
    expect(b.rows.some((r) => r.kind === 'feeTax')).toBe(false);
    expect(b.platformFeeRateBasisPoints).toBe(0);
  });

  /*
    ── A LINE THAT CANNOT SAY WHETHER IT WAS ADDED ────────────────────────────────
    `basis` and `inclusive` were not stored on `BookingTaxLine` until recently, so a booking
    made before then comes back with neither.

    This used to assert "absent means added", on the reasoning that it is how quotes behaved
    before the flag existed. The fixture it asserted it with gave the game away: a total of
    ₹355.22 for a ₹300 subtotal and a ₹55.22 fee, with ₹22.88 of CGST that was plainly NOT in
    it. Treating that as added produced rows coming to ₹378.10 above a ₹355.22 total — the
    exact defect this file exists to catch, written into the file as an expectation.

    The total is known, so this is arithmetic rather than a convention: if the rows without
    the tax already reach the total, nothing was added.
  */
  it('reads an undeclared line as ADDED when the total leaves room for it', () => {
    const b = priceBreakdown(quote({ taxLines: [CGST], totalMinor: 35_522 + 2_288 }));
    expect(b.rows.some((r) => r.label === 'CGST')).toBe(true);
    expect(b.includedTax).toHaveLength(0);
    expect(foots(quote({ taxLines: [CGST], totalMinor: 35_522 + 2_288 }))).toBe(true);
  });

  it('reads an undeclared line as INCLUSIVE when the total already contains it', () => {
    const q = quote({ taxLines: [CGST], totalMinor: 35_522 });
    const b = priceBreakdown(q);
    expect(b.rows.some((r) => r.label === 'CGST')).toBe(false);
    expect(b.includedTax.map((t) => t.label)).toEqual(['CGST']);
    expect(foots(q)).toBe(true);
  });

  /*
    The screen this was reported from, reproduced.

    "Review & pay" listed CGST 9%, SGST 9%, CGST 9% and SGST 9% — the first pair inside the
    ₹799 ticket price, the second pair inside the ₹18.46 platform fee — as four rows above a
    ₹817.46 total. Adding what was on the screen came to ₹941, and the two pairs carried the
    same label, so there was no way for the reader to tell which was which.

    The event page for the same cart was correct, because its quote stated `basis` and
    `inclusive` and the booking's stored lines did not.
  */
  it('does not double-count the fee’s own tax on a booking that predates `basis`', () => {
    const undeclared = (label: string, amountMinor: number) => ({
      label,
      rateBasisPoints: 900,
      amountMinor,
    });
    const q: BreakdownQuote = {
      subtotalMinor: 79_900,
      discountMinor: 0,
      bookingFeeMinor: 1_500,
      paymentFeeMinor: 1_628,
      customerFeeInclusiveMinor: 1_846,
      customerFeeMinor: 1_564,
      feeTaxRateBasisPoints: 1_800,
      taxLines: [
        undeclared('CGST', 6_094),
        undeclared('SGST', 6_094),
        undeclared('CGST', 141),
        undeclared('SGST', 141),
      ],
      totalMinor: 81_746,
    };
    const b = priceBreakdown(q);

    // The tickets and the three fee rows. Not the four GST lines as well.
    expect(b.rows.map((r) => r.kind)).toEqual(['tickets', 'paymentFee', 'platformFee', 'feeTax']);
    expect(foots(q)).toBe(true);
    /*
      And the tax is still stated — below the total, worded as already included, and merged to
      ONE line per rate. Four lines carrying two labels is what the reported screen showed:
      "CGST (9%)" twice with different amounts and nothing to say which was which.
    */
    expect(b.includedTax.map((t) => [t.label, t.amountMinor])).toEqual([
      ['CGST', 6_094 + 141],
      ['SGST', 6_094 + 141],
    ]);
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
