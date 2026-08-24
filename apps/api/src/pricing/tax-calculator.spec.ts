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
      { label: 'Test tax', rateBasisPoints: 1_000, baseMinor: 100_000, amountMinor: 10_000 },
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
