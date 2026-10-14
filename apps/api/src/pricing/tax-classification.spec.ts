import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAX_CATEGORIES } from '@eticketsgo/shared-types';
import {
  TaxClassificationError,
  computeTax,
  ratedTaxCategories,
  requiresTaxClassification,
  type AdmissionLine,
  type TaxCalcResult,
  type TaxRuleInput,
} from './tax-calculator';
import { GST_2_0, INDIA_GST_RULES } from '../../prisma/india-gst-rules';

/**
 * unit - H-8: the tax category is a dedicated classification, and a ticket that cannot be
 * rated is REFUSED, never taxed at an assumed rate.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────
 * The shipped India rules banded on category 'MOVIE' (5% up to Rs 100) and 'Sports' (0% up
 * to Rs 500), but the booking handed the engine the seat category's regulatory class
 * (REGULAR, RECLINER...) as the category. Neither band could ever match, so every cinema and
 * sports ticket fell to the '*' catch-all at 18% - a Rs 90 cinema seat taxed at 18% instead
 * of 5%. Nothing failed: the catch-all made every ticket "work".
 *
 * Every rate below is either the shipped table (inactive everywhere real; activated here only
 * in memory) or a labelled fixture.
 */

/** The shipped India table as the seed writes it, switched on in memory only. */
function shipped(active = true): TaxRuleInput[] {
  return INDIA_GST_RULES.map((r) => ({
    label: r.label,
    rateBasisPoints: r.rateBasisPoints,
    appliesTo: r.appliesTo,
    country: 'India',
    region: '*',
    currency: 'INR',
    taxGroup: r.taxGroup,
    category: r.category,
    minUnitMinor: r.minUnitMinor ?? null,
    maxUnitMinor: r.maxUnitMinor ?? null,
    priority: r.priority,
    inclusive: r.appliesTo === 'TICKETS',
    split: 'CGST_SGST',
    effectiveFrom: GST_2_0,
    active,
  }));
}

/**
 * The table as it shipped BEFORE H-8, still sitting inactive in every database the old seed
 * ran against: cinema on 'MOVIE', sport on 'Sports', and a '*' catch-all at 18%.
 */
function legacyTable(): TaxRuleInput[] {
  const admission = (over: Partial<TaxRuleInput>): TaxRuleInput => ({
    label: 'GST',
    appliesTo: 'TICKETS',
    rateBasisPoints: 1800,
    country: 'India',
    currency: 'INR',
    taxGroup: 'ADMISSION',
    inclusive: true,
    split: 'CGST_SGST',
    active: true,
    ...over,
  });
  return [
    admission({ rateBasisPoints: 500, category: 'MOVIE', maxUnitMinor: 10_000, priority: 10 }),
    admission({ category: 'MOVIE', minUnitMinor: 10_001, priority: 11 }),
    admission({ rateBasisPoints: 0, category: 'Sports', maxUnitMinor: 50_000, priority: 20 }),
    admission({ category: 'Sports', minUnitMinor: 50_001, priority: 21 }),
    admission({ category: '*', priority: 30 }),
  ];
}

const PLACE = {
  country: 'India',
  region: 'Andhra Pradesh',
  supplierRegion: 'Andhra Pradesh',
  currency: 'INR',
  at: new Date('2026-10-14T06:00:00.000Z'),
};

function rate(lines: AdmissionLine[], rules: TaxRuleInput[] = shipped(), place = PLACE) {
  const net = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
  return computeTax({
    netSubtotalMinor: net,
    customerFeeMinor: 0,
    admissionLines: lines,
    rules,
    place,
  });
}

/** The single admission rate one ticket was taxed at, CGST + SGST summed back to one levy. */
function admissionRate(r: TaxCalcResult): number {
  return r.taxLines.filter((l) => l.basis === 'TICKETS').reduce((s, l) => s + l.rateBasisPoints, 0);
}

function refusal(fn: () => unknown): TaxClassificationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaxClassificationError) return err;
    throw err;
  }
  throw new Error('expected a TaxClassificationError, and the order was taxed instead');
}

describe('the classification drives the band', () => {
  it.each([
    ['CINEMA', 9_000, 500],
    ['CINEMA', 10_000, 500],
    ['CINEMA', 10_001, 1800],
    ['CINEMA', 25_000, 1800],
    ['SPORTS_RECOGNISED', 50_000, 0],
    ['SPORTS_RECOGNISED', 50_001, 1800],
    ['LIVE_PERFORMANCE', 49_900, 0],
    ['LIVE_PERFORMANCE', 150_000, 1800],
    ['AMUSEMENT', 9_000, 1800],
    ['OTHER_ENTERTAINMENT', 9_000, 1800],
  ])('%s at %i paise is rated at %i basis points', (category, price, expected) => {
    const r = rate([{ unitPriceMinor: price, quantity: 2, category }]);
    expect(admissionRate(r)).toBe(expected);
    // An exemption is a 0% LINE, not a missing one: "no tax" stays auditable.
    expect(r.taxLines.filter((l) => l.basis === 'TICKETS').length).toBeGreaterThan(0);
    // Inclusive: the tax is inside the price, so nothing is added to the total.
    expect(r.taxAddedMinor).toBe(0);
  });

  it('rates each ticket in one order by its OWN classification and band', () => {
    const r = rate([
      { unitPriceMinor: 9_000, quantity: 1, category: 'CINEMA' },
      { unitPriceMinor: 80_000, quantity: 1, category: 'LIVE_PERFORMANCE' },
    ]);
    const rates = r.taxLines.map((l) => l.rateBasisPoints);
    // 5% cinema as 2.5 + 2.5, 18% performance as 9 + 9.
    expect(rates).toEqual([250, 250, 900, 900]);
  });

  it('a cinema seat is cinema whatever its seat class - the class is not the category', () => {
    /*
      THE OLD PATH. The booking passed the regulatory seat class as the category. Against the
      legacy table that matched no cinema band and the '*' catch-all charged 18% on a Rs 90
      seat (5% is the rate). The engine no longer lets a '*' rule rate a classified ticket, so
      the same legacy order is refused - and the booking now passes the classification.
    */
    const asTheOldBookingSentIt = refusal(() =>
      rate([{ unitPriceMinor: 9_000, quantity: 1, category: 'REGULAR' }], legacyTable()),
    );
    expect(asTheOldBookingSentIt.code).toBe('TAX_RULE_NOT_FOUND');

    const classified = rate([{ unitPriceMinor: 9_000, quantity: 1, category: 'CINEMA' }]);
    expect(admissionRate(classified)).toBe(500);
  });
});

describe('an unclassified or unmapped ticket is refused, never taxed at an assumed rate', () => {
  it('refuses a ticket with no classification, naming it MISSING', () => {
    const err = refusal(() => rate([{ unitPriceMinor: 25_000, quantity: 1, category: null }]));
    expect(err.code).toBe('TAX_CLASSIFICATION_MISSING');
    expect(err.gaps).toEqual([
      { code: 'TAX_CLASSIFICATION_MISSING', category: null, unitPriceMinor: 25_000, lineIndex: 0 },
    ]);
  });

  it.each(['SPORTS_OTHER', 'CONFERENCE', 'Concert'])(
    'refuses %s, which no shipped rule rates, as TAX_RULE_NOT_FOUND',
    (category) => {
      const err = refusal(() => rate([{ unitPriceMinor: 25_000, quantity: 1, category }]));
      expect(err.code).toBe('TAX_RULE_NOT_FOUND');
    },
  );

  it('refuses a classified ticket whose price falls in no band', () => {
    // A fixture table with a hole above Rs 100 - the classification alone is not enough.
    const onlyLow = shipped().filter((r) => !(r.category === 'CINEMA' && r.minUnitMinor));
    const err = refusal(() =>
      rate([{ unitPriceMinor: 10_001, quantity: 1, category: 'CINEMA' }], onlyLow),
    );
    expect(err.code).toBe('TAX_RULE_NOT_FOUND');
  });

  it('refuses the whole order when one line of several cannot be rated', () => {
    const err = refusal(() =>
      rate([
        { unitPriceMinor: 9_000, quantity: 1, category: 'CINEMA' },
        { unitPriceMinor: 9_000, quantity: 1, category: null },
      ]),
    );
    expect(err.gaps.map((g) => g.lineIndex)).toEqual([1]);
  });

  it('does not refuse a free ticket for want of a category - there is nothing to tax', () => {
    const r = rate([
      { unitPriceMinor: 0, quantity: 2, category: null },
      { unitPriceMinor: 25_000, quantity: 1, category: 'CINEMA' },
    ]);
    expect(admissionRate(r)).toBe(1800);
  });

  it('refuses an order total with no per-ticket lines rather than taxing the subtotal', () => {
    const err = refusal(() =>
      computeTax({ netSubtotalMinor: 25_000, customerFeeMinor: 0, rules: shipped(), place: PLACE }),
    );
    expect(err.code).toBe('TAX_CLASSIFICATION_MISSING');
  });
});

describe('with GST inactive - every environment today - nothing changes', () => {
  it('prices an unclassified ticket with no tax at all, exactly as before', () => {
    const r = rate([{ unitPriceMinor: 25_000, quantity: 2, category: null }], shipped(false));
    expect(r).toEqual({ taxLines: [], taxMinor: 0, taxAddedMinor: 0 });
  });

  it('asks nobody for a classification', () => {
    expect(requiresTaxClassification(shipped(false), PLACE)).toBe(false);
    expect(requiresTaxClassification([], PLACE)).toBe(false);
    expect(ratedTaxCategories(shipped(false), PLACE)).toEqual([]);
  });

  it('leaves ungrouped rules - a sales tax on every ticket - untouched by classification', () => {
    // Canada-style: one tax on every ticket, not alternatives. A fixture rate.
    const flat: TaxRuleInput = {
      label: 'Test tax',
      rateBasisPoints: 1_000,
      appliesTo: 'TICKETS',
      country: 'Canada',
    };
    const r = rate([{ unitPriceMinor: 10_000, quantity: 1, category: null }], [flat], {
      ...PLACE,
      country: 'Canada',
      currency: 'CAD',
    });
    expect(r.taxMinor).toBe(1_000);
    expect(requiresTaxClassification([flat], { country: 'Canada' })).toBe(false);
  });
});

describe('the rules are effective-dated', () => {
  const BEFORE = new Date('2025-09-21T12:00:00.000Z');
  const AFTER = new Date('2025-09-23T12:00:00.000Z');
  /** Cinema at or below Rs 100: 12% until GST 2.0, 5% from it. A rate change is a new rule. */
  const history: TaxRuleInput[] = [
    ...shipped().filter((r) => !(r.category === 'CINEMA' && r.maxUnitMinor)),
    {
      ...shipped().find((r) => r.category === 'CINEMA' && r.maxUnitMinor)!,
      rateBasisPoints: 1200,
      effectiveFrom: new Date('2019-01-01T00:00:00.000Z'),
      effectiveTo: GST_2_0,
    },
    shipped().find((r) => r.category === 'CINEMA' && r.maxUnitMinor)!,
  ];
  const line = [{ unitPriceMinor: 9_000, quantity: 1, category: 'CINEMA' }];

  it('rates a sale before the change at the old rate', () => {
    expect(admissionRate(rate(line, history, { ...PLACE, at: BEFORE }))).toBe(1200);
  });

  it('rates a sale after the change at the new rate', () => {
    expect(admissionRate(rate(line, history, { ...PLACE, at: AFTER }))).toBe(500);
  });

  it('refuses a classification whose rule is not yet in force, while others are', () => {
    // A cinema rate written today to start next month does not reach back to rate this sale.
    const cinemaLater = shipped().map((r) =>
      r.category === 'CINEMA' ? { ...r, effectiveFrom: new Date('2026-11-01T00:00:00.000Z') } : r,
    );
    const err = refusal(() => rate(line, cinemaLater));
    expect(err.code).toBe('TAX_RULE_NOT_FOUND');
    // ... and from that date it rates normally.
    const later = { ...PLACE, at: new Date('2026-11-02T00:00:00.000Z') };
    expect(admissionRate(rate(line, cinemaLater, later))).toBe(500);
  });

  it('before ANY rule was in force there is no tax and no assumed rate', () => {
    expect(rate(line, shipped(), { ...PLACE, at: BEFORE }).taxMinor).toBe(0);
  });
});

describe('what the organizer is asked', () => {
  it('requires a classification where classified rules are active, and lists what has a rate', () => {
    expect(requiresTaxClassification(shipped(), PLACE)).toBe(true);
    expect(ratedTaxCategories(shipped(), PLACE)).toEqual([
      'AMUSEMENT',
      'CINEMA',
      'LIVE_PERFORMANCE',
      'OTHER_ENTERTAINMENT',
      'SPORTS_RECOGNISED',
    ]);
  });

  it('every rated category is one an organizer can choose', () => {
    for (const c of ratedTaxCategories(shipped(), PLACE)) {
      expect(TAX_CATEGORIES as readonly string[]).toContain(c);
    }
  });

  it('does not ask in another country', () => {
    expect(requiresTaxClassification(shipped(), { ...PLACE, country: 'Canada' })).toBe(false);
  });
});

describe('the migration is additive', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20261014120000_tax_classification/migration.sql'),
    'utf8',
  );
  const statements = sql
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('--'))
    .join('\n');

  it('only adds nullable columns', () => {
    expect(statements.match(/ADD COLUMN/g)).toHaveLength(3);
    expect(statements).not.toMatch(/NOT NULL|DEFAULT|DROP|UPDATE|DELETE|ALTER COLUMN|RENAME/i);
  });

  it('backfills nothing - a backfilled category would be a guess', () => {
    expect(statements).not.toMatch(/INSERT|UPDATE|SET /i);
  });
});
