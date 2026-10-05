import { computeTax, type TaxRuleInput } from './tax-calculator';
import { INDIA_GST_RULES } from '../../prisma/india-gst-rules';

/**
 * unit — the Indian rule set we actually ship, priced against the published table.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * The tax engine has thorough coverage, all of it against rules written inside the tests. The
 * table somebody types `--activate` against on a production database had none. A wrong band
 * edge or a wrong rate in `seed-india-gst.ts` would have reached a real customer's receipt with
 * every existing test still green.
 *
 * So this imports the shipped rules and prices the worked examples from
 * `docs/guides/INDIA-GST.md`. If that table is edited on an accountant's advice, this fails
 * until the documented examples are updated to match — which is the point.
 *
 * ── WHAT ACTIVATION ACTUALLY DOES TO THE PRICE ─────────────────────────────────────────
 * Indian TICKET prices are quoted inclusive of GST, so the ticket's tax is extracted from the
 * poster price and the buyer is unaffected. The platform FEE is a separate supply and its GST
 * is ADDED - so switching these rules on raises an Indian order by 18% of the customer-borne
 * fee. This file used to claim activation changed nothing the customer pays, backed by an
 * assertion that reduced to `x === x`. It does not, and that makes activation a business
 * decision rather than a bookkeeping one. See `src/pricing/india-order-totals.spec.ts`.
 */

/** The shipped rules, as the seed writes them into the database. */
function shipped(opts: { active: boolean }): TaxRuleInput[] {
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
    // TICKETS are inclusive; the platform fee is charged on top. Mirrors the seed exactly.
    inclusive: r.appliesTo === 'TICKETS',
    split: 'CGST_SGST',
    active: opts.active,
  }));
}

const INTRA_STATE = { country: 'India', region: 'Telangana', supplierRegion: 'Telangana' };

describe('the shipped table matches the published one', () => {
  it('carries exactly the bands the guide documents', () => {
    const summary = INDIA_GST_RULES.map(
      (r) =>
        `${r.category}/${r.appliesTo} ${r.rateBasisPoints} [${r.minUnitMinor ?? '-'}..${r.maxUnitMinor ?? '-'}]`,
    );
    expect(summary).toEqual([
      'MOVIE/TICKETS 500 [-..10000]',
      'MOVIE/TICKETS 1800 [10001..-]',
      'Sports/TICKETS 0 [-..50000]',
      'Sports/TICKETS 1800 [50001..-]',
      '*/TICKETS 1800 [-..-]',
      '*/FEES 1800 [-..-]',
    ]);
  });

  it('bands meet exactly, with no rupee falling between them', () => {
    // ₹100.00 is the 5% band; ₹100.01 is the 18% one. A gap here would untax a ticket.
    const low = INDIA_GST_RULES.find((r) => r.category === 'MOVIE' && r.rateBasisPoints === 500)!;
    const high = INDIA_GST_RULES.find((r) => r.category === 'MOVIE' && r.rateBasisPoints === 1800)!;
    expect(high.minUnitMinor).toBe((low.maxUnitMinor ?? 0) + 1);
  });

  it('puts admission rates in one group, so a band and the catch-all cannot stack', () => {
    /*
      The defect this prevents is named in the seed's own comment: the catch-all once applied on
      top of a banded cinema rate and taxed every cinema ticket twice.
    */
    const admission = INDIA_GST_RULES.filter((r) => r.appliesTo === 'TICKETS');
    expect(new Set(admission.map((r) => r.taxGroup))).toEqual(new Set(['ADMISSION']));
  });

  it('does not guess a rate for the 40% categories', () => {
    // IPL, casinos, betting and racing moved to 40%. Inheriting 18% would under-collect by half.
    const names = INDIA_GST_RULES.map((r) => r.category.toLowerCase());
    for (const forbidden of ['ipl', 'casino', 'betting', 'racing', 'gambling']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('switching it on changes the receipt, not the price', () => {
  /** ₹250 cinema × 2 + ₹20 fee — the first worked example in the guide. */
  const order = {
    netSubtotalMinor: 50_000,
    admissionLines: [{ unitPriceMinor: 25_000, quantity: 2, category: 'MOVIE' }],
    customerFeeMinor: 2_000,
  };

  it('taxes nothing at all while the rules are inactive', () => {
    const out = computeTax({ ...order, rules: shipped({ active: false }), place: INTRA_STATE });
    expect(out.taxMinor).toBe(0);
    expect(out.taxLines).toEqual([]);
  });

  it('adds the FEE GST to the customer total, and nothing from the ticket', () => {
    /*
      ── A CORRECTION TO WHAT THIS TEST USED TO CLAIM ───────────────────────────────────
      It was titled "leaves the customer paying exactly the same once active" and asserted
      `after.taxAddedMinor === before.taxAddedMinor + after.taxAddedMinor - before.taxAddedMinor`
      - which is `x === x` for every possible value. It proved nothing at all, while being
      labelled the property that made activation safe to switch on. It is not that property,
      because the claim is not true.

      What is true: the TICKET's GST is inclusive, so it is extracted from the poster price and
      adds nothing. The platform FEE is a separate supply charged on top, so its GST IS added.
      Activation therefore raises an Indian order by 18% of the customer-borne fee.

      `src/pricing/india-order-totals.spec.ts` prices the whole order through both engines and
      reports the figure at every fee band.
    */
    const before = computeTax({ ...order, rules: shipped({ active: false }), place: INTRA_STATE });
    const after = computeTax({ ...order, rules: shipped({ active: true }), place: INTRA_STATE });

    expect(before.taxMinor).toBe(0);
    expect(before.taxAddedMinor).toBe(0);

    // The ticket contributes inclusive tax: counted in taxMinor, never in taxAddedMinor.
    const admissionTax = after.taxLines
      .filter((l) => l.basis !== 'FEES')
      .reduce((t, l) => t + l.amountMinor, 0);
    const feeTax = after.taxLines
      .filter((l) => l.basis === 'FEES')
      .reduce((t, l) => t + l.amountMinor, 0);

    expect(admissionTax).toBe(7_627);
    expect(feeTax).toBe(360);
    // Only the fee's GST reaches the customer's total. Rs 3.60 on a Rs 20 fee.
    expect(after.taxAddedMinor).toBe(feeTax);
    expect(after.taxMinor).toBe(admissionTax + feeTax);
  });

  it('splits the admission GST into CGST and SGST that add up', () => {
    const out = computeTax({ ...order, rules: shipped({ active: true }), place: INTRA_STATE });
    const cgst = out.taxLines.filter((l) => /CGST/i.test(l.label));
    const sgst = out.taxLines.filter((l) => /SGST/i.test(l.label));
    expect(cgst.length).toBeGreaterThan(0);
    expect(sgst.length).toBeGreaterThan(0);

    /*
      ₹500 inclusive of 18% is ₹423.73 net and ₹76.27 tax, which halves to ₹38.14 and ₹38.13 -
      the odd paisa goes to one side rather than being rounded twice. The guide prints exactly
      these figures.
    */
    const admissionTax = [...cgst, ...sgst]
      .filter((l) => l.basis !== 'FEES')
      .reduce((t, l) => t + l.amountMinor, 0);
    expect(admissionTax).toBe(7_627);
    const halves = [...cgst, ...sgst]
      .filter((l) => l.basis !== 'FEES')
      .map((l) => l.amountMinor)
      .sort((a, b) => b - a);
    expect(halves).toEqual([3_814, 3_813]);
  });

  it('taxes the platform fee as its own supply, on top', () => {
    /*
      Two supplies, two tax lines. The fee is the platform's own service and is charged in
      addition - ₹20 + ₹3.60, not ₹20 inclusive.
    */
    const out = computeTax({ ...order, rules: shipped({ active: true }), place: INTRA_STATE });
    const feeTax = out.taxLines
      .filter((l) => l.basis === 'FEES')
      .reduce((t, l) => t + l.amountMinor, 0);
    expect(feeTax).toBe(360);
  });

  it('prices the ₹90 ticket in the 5% band', () => {
    /*
      The second worked example. A ₹90 seat is below the ₹100 edge, so it is taxed at 5% and
      NOT at the 18% catch-all - which is what the band grouping exists to guarantee.
    */
    const out = computeTax({
      netSubtotalMinor: 18_000,
      admissionLines: [{ unitPriceMinor: 9_000, quantity: 2, category: 'MOVIE' }],
      customerFeeMinor: 1_000,
      rules: shipped({ active: true }),
      place: INTRA_STATE,
    });
    const admissionTax = out.taxLines
      .filter((l) => l.basis !== 'FEES')
      .reduce((t, l) => t + l.amountMinor, 0);
    // ₹180 inclusive of 5% is ₹171.43 net, ₹8.57 tax.
    expect(admissionTax).toBe(857);
  });

  it('charges IGST on admission when the event crosses a state border', () => {
    const out = computeTax({
      ...order,
      rules: shipped({ active: true }),
      place: { country: 'India', region: 'Karnataka', supplierRegion: 'Telangana' },
    });
    const admission = out.taxLines.filter((l) => l.basis !== 'FEES');
    expect(admission.map((l) => l.label)).toEqual(['IGST']);
    // Same money, one line instead of two.
    expect(admission.reduce((t, l) => t + l.amountMinor, 0)).toBe(7_627);
  });

  it('decides the FEE separately, because it is a different supply', () => {
    /*
      Two supplies, two places of supply - s.12(6) for admission, s.12(2) for the booking fee.
      The guide records a real Hyderabad order carrying BOTH presentations at once: the ticket
      intra-state as CGST+SGST, the convenience fee as IGST because the platform is registered
      elsewhere. One pair of states cannot produce that, which is why there are two.
    */
    const out = computeTax({
      ...order,
      rules: shipped({ active: true }),
      place: {
        country: 'India',
        // The event is in Telangana and so is the cinema: admission is intra-state.
        region: 'Telangana',
        supplierRegion: 'Telangana',
        // The buyer is in Telangana; the PLATFORM is registered in Karnataka: the fee crosses.
        customerRegion: 'Telangana',
        platformRegion: 'Karnataka',
      },
    });

    const admission = out.taxLines
      .filter((l) => l.basis !== 'FEES')
      .map((l) => l.label)
      .sort();
    const fee = out.taxLines.filter((l) => l.basis === 'FEES').map((l) => l.label);
    expect(admission).toEqual(['CGST', 'SGST']);
    expect(fee).toEqual(['IGST']);
    // And the money is unchanged by how it is presented.
    expect(out.taxLines.reduce((t, l) => t + l.amountMinor, 0)).toBe(7_627 + 360);
  });

  it('charges the same total whichever way the split falls', () => {
    // 18% is 18% whether it reads as 9 + 9 or as one 18. The customer must not notice.
    const intra = computeTax({ ...order, rules: shipped({ active: true }), place: INTRA_STATE });
    const inter = computeTax({
      ...order,
      rules: shipped({ active: true }),
      place: { country: 'India', region: 'Karnataka', supplierRegion: 'Telangana' },
    });
    expect(inter.taxMinor).toBe(intra.taxMinor);
  });
});

describe('a market that is not India is untouched by any of it', () => {
  it('ignores the Indian table for a US sale', () => {
    const out = computeTax({
      netSubtotalMinor: 50_000,
      admissionLines: [{ unitPriceMinor: 25_000, quantity: 2, category: 'MOVIE' }],
      customerFeeMinor: 2_000,
      rules: shipped({ active: true }),
      place: { country: 'United States', region: 'CA', supplierRegion: 'CA' },
    });
    expect(out.taxMinor).toBe(0);
  });
});
