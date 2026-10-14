import { computeTax, splitTaxAmount, type TaxRuleInput } from './tax-calculator';
import { INDIA_GST_RULES } from '../../prisma/india-gst-rules';

/**
 * One levy, one amount: CGST + SGST must cost exactly what IGST costs.
 *
 * ── THE DEFECT (QA readiness F1, 2026-10-14) ───────────────────────────────────────────
 * With India GST active on QA, the same cart was quoted at 103,960 paise with the fee's GST
 * as CGST 317 + SGST 317, and booked at 103,961 with IGST 635. The fee tax is ADDED to the
 * fee, and the split rounded each 9% half on its own: 0.09 x 3,527 = 317.43 -> 317, twice,
 * against 0.18 x 3,527 = 634.86 -> 635 once. So the buyer's state - which only decides
 * WHICH government is owed the tax - moved the price by a paisa, in either direction
 * (two halves of x.5 each round UP and overshoot instead).
 *
 * ── THE POLICY THIS PINS ────────────────────────────────────────────────────────────────
 * The tax on a line is computed ONCE, at the full rate, in integer minor units, rounded once
 * half-up (Math.round on a non-negative amount). Only then is it divided into its
 * statutory components, and the components always add back to that one figure: an odd
 * paisa goes to the FIRST component (CGST), so 635 -> 318 + 317.
 */
function shipped(): TaxRuleInput[] {
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
    active: true,
  }));
}

const INTRA = {
  country: 'India',
  region: 'Andhra Pradesh',
  supplierRegion: 'Andhra Pradesh',
  customerRegion: 'Andhra Pradesh',
  platformRegion: 'Andhra Pradesh',
};
// Same venue and seller; only the buyer is elsewhere, which moves the FEE to IGST.
const INTER = { ...INTRA, customerRegion: 'Telangana' };

const feeOnly = (feeMinor: number, place: typeof INTRA) =>
  computeTax({
    netSubtotalMinor: 0,
    customerFeeMinor: feeMinor,
    admissionLines: [],
    rules: shipped(),
    place,
  });

describe('splitTaxAmount', () => {
  it('gives the odd paisa to the first half, so the halves add up exactly', () => {
    expect(splitTaxAmount(635, [900, 900])).toEqual([318, 317]);
    expect(splitTaxAmount(634, [900, 900])).toEqual([317, 317]);
    expect(splitTaxAmount(1, [900, 900])).toEqual([1, 0]);
    expect(splitTaxAmount(0, [900, 900])).toEqual([0, 0]);
  });

  it('leaves a single component untouched', () => {
    expect(splitTaxAmount(635, [1800])).toEqual([635]);
  });

  it('always sums to the amount it was given, for any amount and uneven rates', () => {
    for (let total = 0; total <= 5_000; total += 1) {
      for (const rates of [
        [900, 900],
        [901, 900],
        [250, 250],
        [700, 500],
      ]) {
        const parts = splitTaxAmount(total, rates);
        expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
        for (const p of parts) expect(Number.isInteger(p) && p >= 0).toBe(true);
      }
    }
  });
});

describe('GST added to a fee: CGST + SGST equals IGST', () => {
  it('reproduces the QA cart: 635 as one IGST line, 318 + 317 when split', () => {
    const inter = feeOnly(3_527, INTER);
    const intra = feeOnly(3_527, INTRA);

    expect(inter.taxLines.map((l) => [l.label, l.amountMinor])).toEqual([['IGST', 635]]);
    expect(intra.taxLines.map((l) => [l.label, l.amountMinor])).toEqual([
      ['CGST', 318],
      ['SGST', 317],
    ]);
    expect(intra.taxAddedMinor).toBe(inter.taxAddedMinor);
  });

  it('does not overshoot when both halves would round up (the -1 cart)', () => {
    // 0.09 x 50 = 4.5 rounds to 5 twice (10); 0.18 x 50 = 9 exactly.
    const intra = feeOnly(50, INTRA);
    expect(intra.taxLines.map((l) => l.amountMinor)).toEqual([5, 4]);
    expect(intra.taxAddedMinor).toBe(feeOnly(50, INTER).taxAddedMinor);
  });

  it('agrees for every fee from 1 paisa to Rs 200', () => {
    for (let fee = 1; fee <= 20_000; fee += 1) {
      const intra = feeOnly(fee, INTRA);
      const inter = feeOnly(fee, INTER);
      if (intra.taxAddedMinor !== inter.taxAddedMinor) {
        throw new Error(`fee ${fee}: intra ${intra.taxAddedMinor} vs inter ${inter.taxAddedMinor}`);
      }
      // The single figure is the full rate rounded once, half-up.
      expect(inter.taxAddedMinor).toBe(Math.round((fee * 1800) / 10_000));
      const [cgst, sgst] = intra.taxLines.map((l) => l.amountMinor);
      expect(cgst - sgst === 0 || cgst - sgst === 1).toBe(true);
    }
  });
});

describe('GST inside a ticket price: CGST + SGST equals IGST', () => {
  // A ticket rated where the seller is NOT in the venue state, so admission becomes IGST.
  const ADMISSION_INTER = { ...INTRA, supplierRegion: 'Karnataka' };

  it('agrees for every ticket price from Rs 1 to Rs 2,000, on both rates', () => {
    for (let price = 100; price <= 200_000; price += 37) {
      const lines = [{ unitPriceMinor: price, quantity: 3, category: 'CINEMA' }];
      const intra = computeTax({
        netSubtotalMinor: price * 3,
        customerFeeMinor: 0,
        admissionLines: lines,
        rules: shipped(),
        place: INTRA,
      });
      const inter = computeTax({
        netSubtotalMinor: price * 3,
        customerFeeMinor: 0,
        admissionLines: lines,
        rules: shipped(),
        place: ADMISSION_INTER,
      });
      expect(intra.taxMinor).toBe(inter.taxMinor);
      // Inclusive: nothing is added to the price, whichever way it is presented.
      expect(intra.taxAddedMinor).toBe(0);
      const [cgst, sgst] = intra.taxLines.map((l) => l.amountMinor);
      expect(cgst - sgst === 0 || cgst - sgst === 1).toBe(true);
    }
  });
});
