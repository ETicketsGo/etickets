import { FeeMode } from '@eticketsgo/shared-types';
import { calculateFees } from './fee-calculator';
import { computeTax, selectTaxRules, type TaxRuleInput } from './tax-calculator';

/**
 * Every rate in this file is a FIXTURE, invented to exercise arithmetic. None of them is a
 * claim about what any jurisdiction charges — 10% and 7% were chosen precisely because no
 * real market uses them, so nobody can mistake a test constant for a tax position.
 */
const rule = (over: Partial<TaxRuleInput> = {}): TaxRuleInput => ({
  label: 'Test tax',
  rateBasisPoints: 1_000, // 10% — a fixture, not a rate anyone charges
  appliesTo: 'TICKETS',
  active: true,
  ...over,
});

describe('computeTax', () => {
  // ── The default. This is the one that actually ships. ──────────────────────────────
  it('charges nothing when no rules are configured', () => {
    expect(computeTax({ netSubtotalMinor: 100_000, customerFeeMinor: 4_040, rules: [] })).toEqual({
      taxLines: [],
      taxMinor: 0,
      // Nothing to add to the total either. Stated rather than implied: `taxAddedMinor` is
      // what callers put in the total, and a caller reading `taxMinor` for that would
      // charge inclusive tax twice.
      taxAddedMinor: 0,
    });
  });

  it('charges nothing when every configured rule is inactive', () => {
    const r = computeTax({
      netSubtotalMinor: 100_000,
      customerFeeMinor: 4_040,
      rules: [rule({ active: false })],
    });
    expect(r.taxMinor).toBe(0);
  });

  // ── Bases ───────────────────────────────────────────────────────────────────────────
  it('TICKETS taxes the discounted subtotal only', () => {
    const r = computeTax({ netSubtotalMinor: 100_000, customerFeeMinor: 4_040, rules: [rule()] });
    expect(r.taxLines).toEqual([
      {
        label: 'Test tax',
        rateBasisPoints: 1_000,
        baseMinor: 100_000,
        amountMinor: 10_000,
        // Each line now says what it was levied on and whether it sat inside the price, so a
        // caller asking "what did the booking fee cost in total" never has to infer it.
        basis: 'TICKETS',
        inclusive: false,
      },
    ]);
  });

  it('FEES taxes only the fee the customer bears', () => {
    const r = computeTax({
      netSubtotalMinor: 100_000,
      customerFeeMinor: 4_040,
      rules: [rule({ appliesTo: 'FEES' })],
    });
    expect(r.taxLines[0].baseMinor).toBe(4_040);
    expect(r.taxMinor).toBe(404);
  });

  it('never taxes a fee the organizer absorbs', () => {
    // ORGANIZER_PAYS puts the whole fee on the organizer, so customerFeeMinor is 0 and a
    // FEES rule has nothing to bite on. Taxing it would invent a charge the buyer never
    // incurred and print it on their receipt.
    const fees = calculateFees({
      subtotalMinor: 100_000,
      feeMode: FeeMode.ORGANIZER_PAYS,
      taxRules: [rule({ appliesTo: 'FEES' })],
    });
    expect(fees.organizerFeeMinor).toBeGreaterThan(0);
    expect(fees.taxMinor).toBe(0);
  });

  it('TICKETS_AND_FEES taxes both', () => {
    const r = computeTax({
      netSubtotalMinor: 100_000,
      customerFeeMinor: 4_040,
      rules: [rule({ appliesTo: 'TICKETS_AND_FEES' })],
    });
    expect(r.taxLines[0].baseMinor).toBe(104_040);
    expect(r.taxMinor).toBe(10_404);
  });

  it('taxes the discounted amount, not the sticker price', () => {
    const full = computeTax({ netSubtotalMinor: 100_000, customerFeeMinor: 0, rules: [rule()] });
    const discounted = computeTax({
      netSubtotalMinor: 60_000,
      customerFeeMinor: 0,
      rules: [rule()],
    });
    expect(full.taxMinor).toBe(10_000);
    expect(discounted.taxMinor).toBe(6_000);
  });

  // ── Several taxes at once — the normal case in Canada and much of the US. ───────────
  it('produces one independently-rounded line per rule and never compounds', () => {
    const r = computeTax({
      netSubtotalMinor: 33_333,
      customerFeeMinor: 0,
      rules: [
        rule({ label: 'Federal', rateBasisPoints: 1_000, priority: 10 }),
        rule({ label: 'Provincial', rateBasisPoints: 700, priority: 20 }),
      ],
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['Federal', 'Provincial']);
    // Each on the SAME base — the second is not levied on subtotal-plus-first-tax.
    expect(r.taxLines.every((l) => l.baseMinor === 33_333)).toBe(true);
    expect(r.taxLines[0].amountMinor).toBe(3_333); // round(33333 * 0.10)
    expect(r.taxLines[1].amountMinor).toBe(2_333); // round(33333 * 0.07)
    expect(r.taxMinor).toBe(5_666);
    // Falsification: a single combined 17% rate rounds to 5_667 — one paisa apart. If the
    // implementation ever collapses the rates, this assertion fails.
    expect(r.taxMinor).not.toBe(Math.round((33_333 * 1_700) / 10_000));
  });

  it('orders lines by priority, then by label, deterministically', () => {
    const rules = [
      rule({ label: 'Zebra', priority: 5 }),
      rule({ label: 'Alpha', priority: 5 }),
      rule({ label: 'Middle', priority: 1 }),
    ];
    expect(selectTaxRules(rules).map((r) => r.label)).toEqual(['Middle', 'Alpha', 'Zebra']);
    expect(selectTaxRules([...rules].reverse()).map((r) => r.label)).toEqual([
      'Middle',
      'Alpha',
      'Zebra',
    ]);
  });

  // ── Matching ────────────────────────────────────────────────────────────────────────
  it('matches on country, region and currency, with * as any', () => {
    const rules = [
      rule({ label: 'IN only', country: 'India' }),
      rule({ label: 'CA-ON only', country: 'Canada', region: 'ON' }),
      rule({ label: 'Anywhere' }),
    ];
    const inIndia = selectTaxRules(rules, { country: 'India', region: null }).map((r) => r.label);
    expect(inIndia.sort()).toEqual(['Anywhere', 'IN only']);

    const inOntario = selectTaxRules(rules, { country: 'Canada', region: 'ON' }).map(
      (r) => r.label,
    );
    expect(inOntario.sort()).toEqual(['Anywhere', 'CA-ON only']);
  });

  it('does not match a country-scoped rule when the place is unknown', () => {
    // A booking with no venue and no registered address must not silently inherit a
    // jurisdiction's tax. Unknown means "no specific rule applies", never "apply anyway".
    const r = selectTaxRules([rule({ country: 'India' })], { country: null });
    expect(r).toHaveLength(0);
  });

  it('matches case- and whitespace-insensitively', () => {
    expect(selectTaxRules([rule({ country: 'India' })], { country: '  india ' })).toHaveLength(1);
  });

  // ── Effective windows ───────────────────────────────────────────────────────────────
  it('ignores a rule that has not started and one that has ended', () => {
    const at = new Date('2026-06-15T00:00:00Z');
    const rules = [
      rule({ label: 'future', effectiveFrom: new Date('2026-07-01T00:00:00Z') }),
      rule({ label: 'expired', effectiveTo: new Date('2026-01-01T00:00:00Z') }),
      rule({ label: 'current', effectiveFrom: new Date('2026-01-01T00:00:00Z') }),
    ];
    expect(selectTaxRules(rules, { at }).map((r) => r.label)).toEqual(['current']);
  });

  it('never applies a superseded rule and its successor at the same instant', () => {
    // A rate change is a new row, not an edit. At the changeover instant exactly one of the
    // two must apply, or the customer pays both.
    const changeover = new Date('2026-04-01T00:00:00Z');
    const rules = [
      rule({ label: 'old', rateBasisPoints: 1_000, effectiveTo: changeover }),
      rule({ label: 'new', rateBasisPoints: 1_200, effectiveFrom: changeover }),
    ];
    expect(selectTaxRules(rules, { at: changeover }).map((r) => r.label)).toEqual(['new']);
    expect(
      selectTaxRules(rules, { at: new Date(changeover.getTime() - 1) }).map((r) => r.label),
    ).toEqual(['old']);
  });

  // ── Degenerate inputs ───────────────────────────────────────────────────────────────
  it('emits no line for a zero rate or a zero base', () => {
    expect(
      computeTax({
        netSubtotalMinor: 100_000,
        customerFeeMinor: 0,
        rules: [rule({ rateBasisPoints: 0 })],
      }).taxLines,
    ).toHaveLength(0);
    expect(
      computeTax({ netSubtotalMinor: 0, customerFeeMinor: 0, rules: [rule()] }).taxLines,
    ).toHaveLength(0);
  });
});

describe('calculateFees with tax', () => {
  it('leaves every existing total byte-for-byte unchanged when no tax is configured', () => {
    // The compatibility guarantee. These are the exact numbers asserted in
    // fee-calculator.spec.ts before tax existed.
    const r = calculateFees({ subtotalMinor: 100_000, feeMode: FeeMode.CUSTOMER_PAYS });
    expect(r.bookingFeeMinor).toBe(2_000);
    expect(r.paymentFeeMinor).toBe(2_040);
    expect(r.customerFeeMinor).toBe(4_040);
    expect(r.taxMinor).toBe(0);
    expect(r.totalMinor).toBe(104_040);
  });

  it('adds tax on top of the charged amount and keeps the split reconcilable', () => {
    const r = calculateFees({
      subtotalMinor: 100_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
      taxRules: [rule({ appliesTo: 'TICKETS_AND_FEES' })],
    });
    expect(r.taxMinor).toBe(10_404); // 10% of 104_040
    expect(r.totalMinor).toBe(114_444);
    // The money invariant, restated with tax in it.
    expect(r.totalMinor).toBe(r.netSubtotalMinor + r.customerFeeMinor + r.taxMinor);
    expect(r.taxMinor).toBe(r.taxLines.reduce((s, l) => s + l.amountMinor, 0));
  });

  it('does not let tax leak into the organizer fee', () => {
    const r = calculateFees({
      subtotalMinor: 100_000,
      feeMode: FeeMode.SHARED,
      taxRules: [rule()],
    });
    const withoutTax = calculateFees({ subtotalMinor: 100_000, feeMode: FeeMode.SHARED });
    expect(r.organizerFeeMinor).toBe(withoutTax.organizerFeeMinor);
    expect(r.customerFeeMinor).toBe(withoutTax.customerFeeMinor);
    expect(r.totalMinor - withoutTax.totalMinor).toBe(r.taxMinor);
  });
});

/**
 * Indian GST, as the engine has to express it.
 *
 * ── WHY THESE ARE ABOUT SHAPE, NOT ABOUT 18% ──────────────────────────────────────
 * Every rate below is a fixture, not an assertion about Indian law. What is being tested is
 * that the engine can express what the law needs — bands on the price of ONE ticket, a levy
 * that lives inside the price, and one rate that reaches the invoice as two lines or one
 * depending on which side of a state border the venue is.
 *
 * The rates themselves live in `TaxRule` rows and in `docs/guides/INDIA-GST.md`, where
 * somebody qualified to have an opinion can check them. If a rate here were the source of
 * truth, this file would be quietly asserting a tax position — exactly what the header of
 * the module under test refuses to do.
 */
const gst = (over: Record<string, unknown> = {}) =>
  rule({
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    country: 'India',
    currency: 'INR',
    inclusive: true,
    split: 'CGST_SGST',
    ...over,
  });

describe('computeTax — Indian GST shapes', () => {
  const place = { country: 'India', region: 'KA', supplierRegion: 'KA', currency: 'INR' };

  it('bands on the price of ONE ticket, not on the order total', () => {
    /*
      The failure this prevents, and the reason `admissionLines` exists at all: ten 90-rupee
      tickets total 900. Rated off the order that is "above 100" and every one of those
      customers is taxed at the higher band. Rated per ticket — which is how the band is
      written — they are all in the lower one.
    */
    const cheap = computeTax({
      netSubtotalMinor: 9000 * 10,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 9000, quantity: 10, category: 'CINEMA' }],
      rules: [gst({ rateBasisPoints: 500, category: 'CINEMA', maxUnitMinor: 10000 })],
      place,
    });
    expect(cheap.taxMinor).toBeGreaterThan(0);
    // The whole order was rated, at the low band, and inclusively.
    expect(cheap.taxLines[0].baseMinor + cheap.taxMinor).toBe(9000 * 10);
  });

  it('puts each ticket kind in its own band within one order', () => {
    // A 90-rupee seat and a 450-rupee seat bought together are not the same rate, and
    // averaging them is wrong in both directions at once.
    const r = computeTax({
      netSubtotalMinor: 9000 + 45000,
      customerFeeMinor: 0,
      admissionLines: [
        { unitPriceMinor: 9000, quantity: 1, category: 'CINEMA' },
        { unitPriceMinor: 45000, quantity: 1, category: 'CINEMA' },
      ],
      rules: [
        gst({ rateBasisPoints: 500, category: 'CINEMA', maxUnitMinor: 10000 }),
        gst({ rateBasisPoints: 1800, category: 'CINEMA', minUnitMinor: 10001 }),
      ],
      place,
    });
    // Two bands, two levies, four lines once each is split into CGST + SGST.
    expect(r.taxLines).toHaveLength(4);
    // Two distinct taxable bases: only true if the seats were rated separately.
    expect(new Set(r.taxLines.map((l) => l.baseMinor)).size).toBe(2);
  });

  it('REFUSES to rate a banded rule without the per-ticket breakdown', () => {
    // Loud beats silently wrong, when the silent answer is a real overcharge.
    expect(() =>
      computeTax({
        netSubtotalMinor: 90000,
        customerFeeMinor: 0,
        rules: [gst({ category: 'CINEMA', maxUnitMinor: 10000 })],
        place,
      }),
    ).toThrow(/per ticket|admissionLines/i);
  });

  it('takes an inclusive tax OUT of the price instead of adding it', () => {
    /*
      Indian ticket prices are quoted inclusive — 250 on the poster is 250 at the till.
      Adding on top would raise every price by the rate overnight; the customer's total must
      not move when GST is switched on, only the receipt's detail.
    */
    const r = computeTax({
      netSubtotalMinor: 25000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'CINEMA' }],
      rules: [gst({ category: 'CINEMA', minUnitMinor: 10001 })],
      place,
    });
    expect(r.taxAddedMinor).toBe(0);
    // Taxable value plus tax reconstitutes the ticket price exactly.
    expect(r.taxLines[0].baseMinor + r.taxMinor).toBe(25000);
  });

  it('adds an exclusive tax on top, unchanged from how every other market works', () => {
    const r = computeTax({
      netSubtotalMinor: 10000,
      customerFeeMinor: 0,
      rules: [rule({ label: 'Sales tax', rateBasisPoints: 1000, appliesTo: 'TICKETS' })],
    });
    expect(r.taxMinor).toBe(1000);
    expect(r.taxAddedMinor).toBe(1000);
  });

  it('splits one rate into CGST and SGST when the venue is in the seller state', () => {
    const r = computeTax({
      netSubtotalMinor: 25000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'CINEMA' }],
      rules: [gst({ category: 'CINEMA' })],
      place: { ...place, region: 'KA', supplierRegion: 'KA' },
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
    expect(r.taxLines.every((l) => l.rateBasisPoints === 900)).toBe(true);
  });

  it('charges IGST instead when the event is in another state', () => {
    const r = computeTax({
      netSubtotalMinor: 25000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'CINEMA' }],
      rules: [gst({ category: 'CINEMA' })],
      place: { ...place, region: 'MH', supplierRegion: 'KA' },
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['IGST']);
    expect(r.taxLines[0].rateBasisPoints).toBe(1800);
  });

  it('charges the SAME AMOUNT whichever side of the border it is', () => {
    /*
      The property that makes an unknown state survivable. Which government is owed the
      money changes; how much the customer pays does not. So a missing venue state mislabels
      an invoice — a real compliance problem — but can never overcharge anybody.
    */
    const args = {
      netSubtotalMinor: 25000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'CINEMA' }],
      rules: [gst({ category: 'CINEMA' })],
    };
    const intra = computeTax({ ...args, place: { ...place, region: 'KA', supplierRegion: 'KA' } });
    const inter = computeTax({ ...args, place: { ...place, region: 'MH', supplierRegion: 'KA' } });
    expect(intra.taxMinor).toBe(inter.taxMinor);
  });

  it('treats an unknown seller state as intra-state rather than guessing a border', () => {
    const r = computeTax({
      netSubtotalMinor: 25000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'CINEMA' }],
      rules: [gst({ category: 'CINEMA' })],
      place: { country: 'India', region: 'KA', currency: 'INR' },
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
  });

  it('taxes the booking fee as its own supply, at its own rate', () => {
    // The platform fee is the platform's service. It is not admission and does not share
    // admission's band — which is why an Indian ticket receipt carries two different taxes.
    const r = computeTax({
      netSubtotalMinor: 9000,
      customerFeeMinor: 2000,
      admissionLines: [{ unitPriceMinor: 9000, quantity: 1, category: 'CINEMA' }],
      rules: [
        gst({ rateBasisPoints: 500, category: 'CINEMA', maxUnitMinor: 10000 }),
        gst({ rateBasisPoints: 1800, appliesTo: 'FEES', category: 'FEE' }),
      ],
      place,
    });
    // The fee was rated on the fee, not folded into the ticket's base.
    expect(r.taxLines.some((l) => l.baseMinor < 2000 && l.baseMinor > 1500)).toBe(true);
  });

  it('emits a zero-rate line for a deliberate exemption rather than nothing at all', () => {
    /*
      "We charged you no tax on this" and "we never considered tax" look identical on a
      receipt that omits the line, and only one of them is auditable. India exempts
      recognised sporting fixtures at or below a threshold; that is a 0% line, not a gap.
    */
    const r = computeTax({
      netSubtotalMinor: 40000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 40000, quantity: 1, category: 'SPORT' }],
      rules: [gst({ rateBasisPoints: 0, category: 'SPORT', maxUnitMinor: 50000 })],
      place,
    });
    expect(r.taxLines).toHaveLength(2);
    expect(r.taxMinor).toBe(0);
  });

  it('still charges nothing at all when India has no rules configured', () => {
    // The default that ships. Enabling GST is a deliberate act, never a consequence of
    // deploying this code.
    const r = computeTax({
      netSubtotalMinor: 25000,
      customerFeeMinor: 2000,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'CINEMA' }],
      rules: [],
      place,
    });
    expect(r).toEqual({ taxLines: [], taxMinor: 0, taxAddedMinor: 0 });
  });
});

describe('an inclusive tax always reconciles with the price', () => {
  /*
    The invariant, asserted across awkward numbers rather than one convenient example.

    A receipt has to foot: whatever the customer paid must equal the taxable value plus
    every tax line on it, to the paisa. Deriving the taxable value rounds once and each
    component rounds again, so this is exactly where a stray unit hides — and a paisa that
    belongs to nobody is a receipt that does not add up, not a rounding preference.
  */
  const inclusiveGst = (over: Record<string, unknown> = {}) =>
    rule({
      label: 'GST',
      rateBasisPoints: 1800,
      appliesTo: 'TICKETS',
      inclusive: true,
      split: 'CGST_SGST',
      ...over,
    });

  const prices = [1, 7, 99, 100, 12345, 25000, 33333, 99999, 100001];

  for (const border of ['intra', 'inter'] as const) {
    it(`holds for an ${border}-state sale at every awkward price`, () => {
      /*
        Mapped rather than asserted in the loop, so a failure names the price it failed at
        instead of stopping at the first one and saying only "expected 25000, got 24999".
      */
      const footed = prices.map((price) => {
        const r = computeTax({
          netSubtotalMinor: price,
          customerFeeMinor: 0,
          admissionLines: [{ unitPriceMinor: price, quantity: 1 }],
          rules: [inclusiveGst()],
          place: { region: 'KA', supplierRegion: border === 'intra' ? 'KA' : 'MH' },
        });
        const taxable = r.taxLines[0]?.baseMinor ?? price;
        return { price, footsTo: taxable + r.taxMinor, added: r.taxAddedMinor };
      });

      expect(footed).toEqual(
        // Every price reconstitutes itself, and none of it was added to the total —
        // it was never outside the price to begin with.
        prices.map((price) => ({ price, footsTo: price, added: 0 })),
      );
    });
  }

  it('holds for several rates, not just eighteen percent', () => {
    const rates = [0, 500, 1200, 1800, 2800, 4000];
    const footed = rates.map((rateBasisPoints) => {
      const r = computeTax({
        netSubtotalMinor: 33_333,
        customerFeeMinor: 0,
        admissionLines: [{ unitPriceMinor: 33_333, quantity: 1 }],
        rules: [inclusiveGst({ rateBasisPoints })],
        place: { region: 'KA', supplierRegion: 'KA' },
      });
      const taxable = r.taxLines[0]?.baseMinor ?? 33_333;
      return { rateBasisPoints, footsTo: taxable + r.taxMinor };
    });
    expect(footed).toEqual(rates.map((rateBasisPoints) => ({ rateBasisPoints, footsTo: 33_333 })));
  });
});

describe('alternatives, not additions', () => {
  /*
    ── THE BUG THESE EXIST FOR ────────────────────────────────────────────────────────
    India's admission rate bands by what is sold AND needs a catch-all for everything the
    bands do not name. With no way to say "these are alternatives", the catch-all matched
    every cinema ticket too — so a ₹250 seat was taxed at the cinema rate AND at the general
    rate, and the receipt carried CGST and SGST twice over the same base.

    Thirty-three unit tests missed it, because every one of them configured a single rule
    per scenario. It was found by pricing a real order against the real rule table. These
    tests are the shape of that order.
  */
  const admission = (over: Record<string, unknown> = {}) =>
    rule({
      label: 'GST',
      appliesTo: 'TICKETS',
      inclusive: true,
      split: 'CGST_SGST',
      taxGroup: 'ADMISSION',
      ...over,
    });

  const place = { region: 'KA', supplierRegion: 'KA' };

  /** The real Indian table in miniature: two cinema bands and a catch-all beneath them. */
  const indiaAdmission = [
    admission({ rateBasisPoints: 500, category: 'MOVIE', maxUnitMinor: 10000, priority: 10 }),
    admission({ rateBasisPoints: 1800, category: 'MOVIE', minUnitMinor: 10001, priority: 11 }),
    admission({ rateBasisPoints: 1800, category: '*', priority: 30 }),
  ];

  it('taxes a cinema ticket ONCE, not once per matching rule', () => {
    const r = computeTax({
      netSubtotalMinor: 50000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 2, category: 'MOVIE' }],
      rules: indiaAdmission,
      place,
    });
    // One levy, split into two halves. Four lines would mean the catch-all stacked.
    expect(r.taxLines).toHaveLength(2);
    expect(r.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
    // And it still foots against the price it came out of.
    expect(r.taxLines[0].baseMinor + r.taxMinor).toBe(50000);
  });

  it('lets the catch-all take what no band claimed', () => {
    // A concert is not cinema, so the specific rules do not match and the general one must.
    const r = computeTax({
      netSubtotalMinor: 150000,
      customerFeeMinor: 0,
      admissionLines: [{ unitPriceMinor: 150000, quantity: 1, category: 'Music' }],
      rules: indiaAdmission,
      place,
    });
    expect(r.taxLines).toHaveLength(2);
    expect(r.taxLines[0].baseMinor + r.taxMinor).toBe(150000);
  });

  it('resolves the group PER TICKET, so one order can use two bands', () => {
    /*
      The reason the contest cannot be settled once for the whole order. A cheap seat and an
      expensive seat bought together belong to different bands of the same group, and picking
      one winner for the order would put one of them on the wrong rate.
    */
    const r = computeTax({
      netSubtotalMinor: 9000 + 25000,
      customerFeeMinor: 0,
      admissionLines: [
        { unitPriceMinor: 9000, quantity: 1, category: 'MOVIE' },
        { unitPriceMinor: 25000, quantity: 1, category: 'MOVIE' },
      ],
      rules: indiaAdmission,
      place,
    });
    // Two levies at two different rates, each split in half.
    expect(r.taxLines).toHaveLength(4);
    const rates = [...new Set(r.taxLines.map((l) => l.rateBasisPoints))].sort((a, b) => a - b);
    expect(rates).toEqual([250, 900]);
    // Both seats together still foot exactly against what was paid for them.
    const taxable = [...new Set(r.taxLines.map((l) => l.baseMinor))].reduce((a, b) => a + b, 0);
    expect(taxable + r.taxMinor).toBe(9000 + 25000);
  });

  it('still stacks UNGROUPED rules, because two taxes at once is normal', () => {
    /*
      Canada charges GST and PST on the same sale, and several US states add a city rate to a
      state rate. Grouping is opt-in precisely so this keeps working untouched.
    */
    const r = computeTax({
      netSubtotalMinor: 10000,
      customerFeeMinor: 0,
      rules: [
        rule({ label: 'GST', rateBasisPoints: 500, appliesTo: 'TICKETS' }),
        rule({ label: 'PST', rateBasisPoints: 700, appliesTo: 'TICKETS' }),
      ],
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['GST', 'PST']);
    expect(r.taxMinor).toBe(1200);
  });

  it('taxes the booking fee in its OWN group, so admission never suppresses it', () => {
    // The platform's fee is a different supply. It has to survive alongside whichever
    // admission rule won, which is only true if it is in a group of its own.
    const r = computeTax({
      netSubtotalMinor: 25000,
      customerFeeMinor: 2000,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 1, category: 'MOVIE' }],
      rules: [
        ...indiaAdmission,
        admission({ rateBasisPoints: 1800, appliesTo: 'FEES', taxGroup: 'FEE', priority: 40 }),
      ],
      place,
    });
    // Admission split in two, plus the fee split in two.
    expect(r.taxLines).toHaveLength(4);
    const bases = [...new Set(r.taxLines.map((l) => l.baseMinor))];
    expect(bases).toHaveLength(2);
  });

  it('the customer pays the ticket price whether or not the rules are active', () => {
    /*
      The property that makes switching GST on safe. An inclusive levy takes its share out of
      a price that was always that price; the customer's total must not move, only the
      receipt's detail.
    */
    const args = {
      netSubtotalMinor: 50000,
      customerFeeMinor: 2000,
      admissionLines: [{ unitPriceMinor: 25000, quantity: 2, category: 'MOVIE' }],
      place,
    };
    const off = computeTax({ ...args, rules: [] });
    const on = computeTax({
      ...args,
      rules: [
        ...indiaAdmission,
        admission({ rateBasisPoints: 1800, appliesTo: 'FEES', taxGroup: 'FEE', priority: 40 }),
      ],
    });
    expect(on.taxAddedMinor).toBe(off.taxAddedMinor);
    expect(on.taxMinor).toBeGreaterThan(0);
  });
});

describe('one order, two places of supply', () => {
  /*
    ── WHERE THIS COMES FROM ──────────────────────────────────────────────────────────
    A real BookMyShow order summary for a Hyderabad cinema, two seats:

        Ticket(s) price                  ₹300.00
          Net ticket price   ₹236.00
          GST                 ₹54.00
          TMC                 ₹10.00
        Convenience fees                  ₹47.20
          Base amount         ₹40.00
          Integrated GST (IGST) @ 18%   ₹7.20

    The ticket is an admission in Telangana sold by a Telangana cinema. The convenience fee
    on the SAME order is charged as IGST, because the platform is registered in another state
    and the buyer is in Telangana. Admission follows s.12(6) — where the event is held — and
    a platform's service follows s.12(2) — where the recipient is.

    The engine used to apply the venue's state to both, which cannot produce this order.
  */
  const place = {
    // The cinema and the event are both in Telangana: an intra-state admission.
    region: 'TG',
    supplierRegion: 'TG',
    // The buyer is in Telangana; the platform is registered in Maharashtra: inter-state fee.
    customerRegion: 'TG',
    platformRegion: 'MH',
    currency: 'INR',
  };

  const admission = rule({
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    inclusive: true,
    split: 'CGST_SGST',
    taxGroup: 'ADMISSION',
  });
  const fee = rule({
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'FEES',
    split: 'CGST_SGST',
    taxGroup: 'FEE',
  });

  it('splits the ticket into CGST + SGST and charges IGST on the fee, in ONE order', () => {
    const r = computeTax({
      netSubtotalMinor: 30_000,
      customerFeeMinor: 4_000,
      admissionLines: [{ unitPriceMinor: 15_000, quantity: 2 }],
      rules: [admission, fee],
      place,
    });

    const labels = r.taxLines.map((l) => l.label);
    expect(labels).toContain('CGST');
    expect(labels).toContain('SGST');
    expect(labels).toContain('IGST');

    // The IGST line is the one on the fee, at the full rate rather than halved.
    const igst = r.taxLines.find((l) => l.label === 'IGST')!;
    expect(igst.rateBasisPoints).toBe(1800);
  });

  it('charges 18% ON TOP of the booking fee, matching ₹40.00 → ₹47.20 exactly', () => {
    // The fee rule is exclusive: the customer pays the fee plus its tax, which is how the
    // convenience fee is decomposed on a real order.
    const r = computeTax({
      netSubtotalMinor: 30_000,
      customerFeeMinor: 4_000,
      admissionLines: [{ unitPriceMinor: 15_000, quantity: 2 }],
      rules: [fee],
      place,
    });
    expect(r.taxMinor).toBe(720);
    expect(r.taxAddedMinor).toBe(720);
  });

  it('would charge CGST + SGST on the fee if the platform were in the buyer’s state', () => {
    // The same rule, the same order, a platform registered locally — and the split changes.
    const r = computeTax({
      netSubtotalMinor: 30_000,
      customerFeeMinor: 4_000,
      admissionLines: [{ unitPriceMinor: 15_000, quantity: 2 }],
      rules: [fee],
      place: { ...place, platformRegion: 'TG' },
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
    // Same money either way — only which government is owed it changes.
    expect(r.taxMinor).toBe(720);
  });

  it('does not let the venue’s state decide the FEE, which was the bug', () => {
    /*
      The venue and the seller are both in Telangana, so the OLD single-pair rule made every
      line intra-state. The fee must still be IGST, because the platform is elsewhere.
    */
    const r = computeTax({
      netSubtotalMinor: 30_000,
      customerFeeMinor: 4_000,
      admissionLines: [{ unitPriceMinor: 15_000, quantity: 2 }],
      rules: [fee],
      place: { region: 'TG', supplierRegion: 'TG', customerRegion: 'TG', platformRegion: 'MH' },
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['IGST']);
  });

  it('falls back to intra-state when the buyer’s state is unknown, as it does today', () => {
    // We do not yet ask a buyer for their state. Unknown must behave exactly as before rather
    // than guessing a border — and it cannot overcharge, because the rate is the same.
    const r = computeTax({
      netSubtotalMinor: 30_000,
      customerFeeMinor: 4_000,
      admissionLines: [{ unitPriceMinor: 15_000, quantity: 2 }],
      rules: [fee],
      place: { region: 'TG', supplierRegion: 'TG', platformRegion: 'MH' },
    });
    expect(r.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
    expect(r.taxMinor).toBe(720);
  });
});
