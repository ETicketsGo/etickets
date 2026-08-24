/**
 * Tax computation. Pure, deterministic, and — deliberately — ignorant of tax law.
 *
 * ── WHAT THIS FILE WILL NOT DO ────────────────────────────────────────────────────────
 * It contains no rate, no threshold, and no jurisdiction rule. Not 18%, not 5%, not 13%.
 * Every number comes from a `TaxRule` row an owner deliberately activated, on the advice of
 * whoever is qualified to give it. Hardcoding a rate here to "finish the flow" would mean
 * this repository quietly asserting a tax position for three countries, and would be wrong
 * within a year of any rate change even if it were right today.
 *
 * The consequence, stated plainly: with no rules configured, tax is zero and every total is
 * byte-for-byte what it was before this file existed. That is the correct default. The
 * alternative — guessing — over- or under-charges real customers.
 */

/** What a rule is levied on. Mirrors the `TaxBase` enum in the Prisma schema. */
export type TaxBaseKind = 'TICKETS' | 'FEES' | 'TICKETS_AND_FEES';

/** A tax rule as the calculator needs it — the DB row minus its bookkeeping columns. */
export interface TaxRuleInput {
  label: string;
  /** Basis points: 1800 = 18.00%. Integer, because a float rate reintroduces drift. */
  rateBasisPoints: number;
  appliesTo: TaxBaseKind;
  country?: string;
  region?: string;
  currency?: string;
  priority?: number;
  active?: boolean;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}

/** Where and when a booking is happening, for matching rules. */
export interface TaxPlace {
  country?: string | null;
  region?: string | null;
  currency?: string | null;
  at?: Date;
}

/** One tax charged, itemised so a receipt can show it and an auditor can redo the sum. */
export interface TaxLine {
  label: string;
  rateBasisPoints: number;
  /** The amount the rate was applied to. */
  baseMinor: number;
  amountMinor: number;
}

export interface TaxCalcResult {
  taxLines: TaxLine[];
  taxMinor: number;
}

const WILDCARD = '*';

function matches(ruleValue: string | undefined, actual: string | null | undefined): boolean {
  const rule = (ruleValue ?? WILDCARD).trim();
  if (rule === WILDCARD || rule === '') return true;
  if (actual == null) return false;
  return rule.toUpperCase() === actual.trim().toUpperCase();
}

function inEffect(rule: TaxRuleInput, at: Date): boolean {
  if (rule.effectiveFrom && at < rule.effectiveFrom) return false;
  // Exclusive upper bound: a rule effective "to" the instant a successor starts must not
  // both apply at that instant, or the customer is taxed twice for one moment.
  if (rule.effectiveTo && at >= rule.effectiveTo) return false;
  return true;
}

/**
 * The rules that apply to one booking, most-specific first.
 *
 * Specificity ordering matters for presentation only — every line is computed on its own
 * base, so no rule ever compounds on another. Two taxes at once is the normal case, not an
 * edge case: Canada charges federal and provincial tax side by side, and several US states
 * add a city rate on top of the state rate.
 */
export function selectTaxRules(rules: TaxRuleInput[], place: TaxPlace = {}): TaxRuleInput[] {
  const at = place.at ?? new Date();
  return rules
    .filter((r) => r.active !== false)
    .filter((r) => inEffect(r, at))
    .filter(
      (r) =>
        matches(r.country, place.country) &&
        matches(r.region, place.region) &&
        matches(r.currency, place.currency),
    )
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.label.localeCompare(b.label));
}

function baseFor(rule: TaxRuleInput, netSubtotalMinor: number, customerFeeMinor: number): number {
  switch (rule.appliesTo) {
    case 'TICKETS':
      return netSubtotalMinor;
    case 'FEES':
      return customerFeeMinor;
    case 'TICKETS_AND_FEES':
      return netSubtotalMinor + customerFeeMinor;
    default:
      return 0;
  }
}

export interface TaxCalcInput {
  /** Ticket subtotal after any discount — a discount reduces the taxable amount. */
  netSubtotalMinor: number;
  /**
   * Only the fee the CUSTOMER pays. Fees the organizer absorbs are the organizer's own tax
   * matter and never appear on the customer's receipt, so taxing them here would invent a
   * charge nobody owes.
   */
  customerFeeMinor: number;
  rules: TaxRuleInput[];
  place?: TaxPlace;
}

/**
 * Compute the tax lines for one booking.
 *
 * Each line rounds independently. That is not a shortcut — it is how a multi-tax
 * jurisdiction actually works: Canada computes GST and PST as separate amounts on the same
 * base, and each is rounded to the cent on its own. Rounding a combined rate once would
 * produce a total that neither tax authority's arithmetic agrees with.
 */
export function computeTax(input: TaxCalcInput): TaxCalcResult {
  const net = Math.max(0, Math.round(input.netSubtotalMinor));
  const custFee = Math.max(0, Math.round(input.customerFeeMinor));
  const applicable = selectTaxRules(input.rules, input.place);

  const taxLines: TaxLine[] = [];
  for (const rule of applicable) {
    const rate = Math.round(rule.rateBasisPoints);
    if (rate <= 0) continue;
    const baseMinor = baseFor(rule, net, custFee);
    if (baseMinor <= 0) continue;
    taxLines.push({
      label: rule.label,
      rateBasisPoints: rate,
      baseMinor,
      amountMinor: Math.round((baseMinor * rate) / 10_000),
    });
  }

  return { taxLines, taxMinor: taxLines.reduce((sum, l) => sum + l.amountMinor, 0) };
}
