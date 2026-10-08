import { calculateFees, DEFAULT_FEE_TIERS, DEFAULT_PAYMENT_FEE_BPS } from './fee-calculator';
import { computeTax, type TaxRuleInput } from './tax-calculator';
import { INDIA_GST_RULES } from '../../prisma/india-gst-rules';
import { FeeMode } from '@eticketsgo/shared-types';

/**
 * unit - what an Indian buyer is actually charged, at every fee band, GST off and on.
 *
 * ── WHY THIS COMPOSES THE TWO ENGINES BY HAND ──────────────────────────────────────────
 * It mirrors `PricingService.quote`, which is the real path: fees are calculated with NO tax
 * rules, then tax is rated separately with `admissionLines`, and the total adds
 * **`taxAddedMinor`** - not `taxMinor` - because an inclusive tax is already inside the ticket
 * price.
 *
 * Do not be tempted to pass `taxRules` straight into `calculateFees` instead. It accepts them,
 * and then computes `totalMinor = netSubtotal + customerFee + taxMinor`, which double-charges
 * an inclusive tax; with a BANDED rule it throws outright, because it does not forward
 * `admissionLines`. No production caller passes them. This test exists partly to pin the
 * composition that is correct.
 */

function shipped(active: boolean): TaxRuleInput[] {
  return INDIA_GST_RULES.map((r) => ({
    label: r.label,
    rateBasisPoints: r.rateBasisPoints,
    appliesTo: r.appliesTo,
    country: 'India',
    region: '*',
    currency: '*',
    taxGroup: r.taxGroup,
    category: r.category,
    minUnitMinor: r.minUnitMinor ?? null,
    maxUnitMinor: r.maxUnitMinor ?? null,
    priority: r.priority,
    inclusive: r.appliesTo === 'TICKETS',
    split: 'CGST_SGST',
    active,
  }));
}

const PLACE = { country: 'India', region: 'Telangana', supplierRegion: 'Telangana' };

/** One ticket at `unitMinor`, priced the way the quote endpoint prices it. */
function quote(unitMinor: number, active: boolean) {
  const fees = calculateFees({
    subtotalMinor: unitMinor,
    feeMode: FeeMode.CUSTOMER_PAYS,
    currency: 'INR',
  });
  const tax = computeTax({
    netSubtotalMinor: fees.netSubtotalMinor,
    customerFeeMinor: fees.customerFeeMinor,
    admissionLines: [{ unitPriceMinor: unitMinor, quantity: 1, category: 'MOVIE' }],
    rules: shipped(active),
    place: PLACE,
  });
  return {
    ticketMinor: fees.netSubtotalMinor,
    bookingFeeMinor: fees.bookingFeeMinor,
    paymentFeeMinor: fees.paymentFeeMinor,
    customerFeeMinor: fees.customerFeeMinor,
    organizerFeeMinor: fees.organizerFeeMinor,
    taxMinor: tax.taxMinor,
    taxAddedMinor: tax.taxAddedMinor,
    buyerPaysMinor: fees.netSubtotalMinor + fees.customerFeeMinor + tax.taxAddedMinor,
  };
}

/** The amounts asked for, plus each fee-band edge. */
const CASES = [10_000, 19_900, 20_000, 49_900, 50_000, 99_900, 100_000, 159_800];

describe('the India price table, from the real engines', () => {
  it('prints every representative amount, GST off and on', () => {
    const rows = CASES.map((unit) => {
      const off = quote(unit, false);
      const on = quote(unit, true);
      return {
        ticket: unit,
        bookingFee: off.bookingFeeMinor,
        paymentFee: off.paymentFeeMinor,
        customerFee: off.customerFeeMinor,
        buyerPays_gstOff: off.buyerPaysMinor,
        gstTotal_on: on.taxMinor,
        gstAdded_on: on.taxAddedMinor,
        buyerPays_gstOn: on.buyerPaysMinor,
      };
    });
    // Printed so the figures in the launch document are evidence rather than a claim.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows));
    expect(rows).toHaveLength(CASES.length);
  });

  it('THE REAL ANSWER: activation DOES raise the buyer total, by the GST on the fee', () => {
    /*
      ── A CLAIM I HAD TO WITHDRAW ──────────────────────────────────────────────────────
      It was previously recorded, by me, that "activation changes what the receipt says, not
      what the customer pays". That is true of the TICKET and false of the ORDER.

      A ticket price is quoted inclusive, so its GST comes out of the poster price and the
      buyer is unaffected. The platform/convenience fee is a separate supply and its GST is
      ADDED. So switching the rules on raises every Indian order by 18% of the customer-borne
      fee - Rs 1.28 on a Rs 100 ticket.

      That is a price change to real customers, which makes activation a BUSINESS decision and
      not merely a bookkeeping one. The number is asserted here so nobody has to rediscover it.
    */
    for (const unit of CASES) {
      const off = quote(unit, false);
      const on = quote(unit, true);
      const delta = on.buyerPaysMinor - off.buyerPaysMinor;

      // Every added paisa is fee GST, and nothing else.
      expect({ unit, delta }).toEqual({ unit, delta: on.taxAddedMinor });
      expect(delta).toBeGreaterThan(0);

      /*
        And it is 18% of the customer-borne fee, to within rounding. Asserted as a band rather
        than an exact figure because the booking fee and the payment fee are rated as separate
        lines and each rounds on its own - 18% of the summed fee is off by a paisa at some
        amounts, and a test that hard-codes my arithmetic instead of the engine's teaches
        nothing.
      */
      expect(delta).toBeGreaterThanOrEqual(Math.floor((off.customerFeeMinor * 1790) / 10_000));
      expect(delta).toBeLessThanOrEqual(Math.ceil((off.customerFeeMinor * 1810) / 10_000));
    }
  });

  it('leaves the TICKET half of the money untouched by activation', () => {
    // The inclusive half really is unchanged: this is the part the earlier claim got right.
    for (const unit of CASES) {
      const on = quote(unit, true);
      const admissionTaxMinor = on.taxMinor - on.taxAddedMinor;
      // All of the ticket's GST is inclusive, i.e. none of it is added to the buyer.
      expect(on.ticketMinor).toBe(quote(unit, false).ticketMinor);
      expect(admissionTaxMinor).toBeGreaterThan(0);
    }
  });

  it('taxes the ticket inclusively and the fee on top', () => {
    const on = quote(25_000, true);
    // 18% inside Rs 250 is Rs 38.14; the fee's GST is added, so taxAdded < taxTotal.
    expect(on.taxMinor).toBeGreaterThan(on.taxAddedMinor);
    expect(on.taxAddedMinor).toBeGreaterThan(0);
  });

  it('uses the documented default fee bands and payment fee', () => {
    expect(DEFAULT_PAYMENT_FEE_BPS).toBe(200);
    expect(DEFAULT_FEE_TIERS.map((t) => [t.minMinor, t.maxMinor, t.feeMinor])).toEqual([
      [0, 19_900, 500],
      [20_000, 49_900, 1_000],
      [50_000, 99_900, 1_500],
      [100_000, null, 2_000],
    ]);
  });

  it('charges the lower band in the gap between bands', () => {
    /*
      The bands have holes: Rs 199.01-199.99, Rs 499.01-499.99, Rs 999.01-999.99 match no band.
      `resolveBookingFee` falls back to the nearest band at or below, so a price in a hole is
      charged the lower fee rather than refused. Documented because it is a real edge a
      tax-inclusive price can land on.
    */
    expect(quote(19_950, false).bookingFeeMinor).toBe(500);
    expect(quote(49_950, false).bookingFeeMinor).toBe(1_000);
  });
});
