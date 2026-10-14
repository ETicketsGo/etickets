import { regionMatches } from '@eticketsgo/shared-types';

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
 * What it DOES know is shape: that a rate can band on the price of one ticket, that a levy
 * can sit inside a price or on top of it, that two rules can be alternatives rather than
 * additions, and that one rate can reach an invoice as two lines or one depending on where
 * the event is. Those are structures, not rates, and India needs all four.
 *
 * The consequence, stated plainly: with no rules configured, tax is zero and every total is
 * byte-for-byte what it was before this file existed. That is the correct default. The
 * alternative — guessing — over- or under-charges real customers.
 */

/** What a rule is levied on. Mirrors the `TaxBase` enum in the Prisma schema. */
export type TaxBaseKind = 'TICKETS' | 'FEES' | 'TICKETS_AND_FEES' | 'MAINTENANCE';

/**
 * How one levy is presented once the place of supply is known.
 *
 * `NONE` is a single line — a sales tax, a VAT, most of the world.
 *
 * `CGST_SGST` is India's dual levy. One rate, but it reaches the receipt as two halves when
 * the sale is intra-state and as a single IGST line when it crosses a state border. The rate
 * is the same either way, so the customer pays the same amount whichever it is; what changes
 * is which government is owed it, and therefore what the invoice must say.
 */
export type TaxSplitKind = 'NONE' | 'CGST_SGST';

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

  /**
   * Rules that are ALTERNATIVES rather than additions.
   *
   * Empty — the default — means "always applies", which is what a second tax layer needs:
   * Canada charges GST and PST on the same sale, and several US states add a city rate on
   * top of a state rate.
   *
   * A non-empty group means exactly one of its rules is used, lowest priority number first.
   * India needs this because its admission rate bands by what is being sold AND has a
   * catch-all for everything else; without grouping the catch-all applied on top of the
   * banded cinema rate and every cinema ticket was taxed twice.
   */
  taxGroup?: string;

  /**
   * The kind of thing being admitted to — '*' for anything.
   *
   * Rates band by WHAT is sold, not only by where. India taxes a cinema seat, a recognised
   * sporting fixture and a concert at three different rates, and no amount of geography
   * distinguishes them.
   */
  category?: string;

  /**
   * Price band, matched against the UNIT price of one ticket — never the order total.
   *
   * This distinction is the whole reason `admissionLines` exists. Ten ₹90 tickets are ten
   * ₹90 tickets; rating them off a ₹900 order total puts them in the wrong band and
   * overcharges every one of them. Bounds are inclusive on both ends; null is unbounded.
   */
  minUnitMinor?: number | null;
  maxUnitMinor?: number | null;

  /**
   * Whether the price already contains this tax.
   *
   * India quotes ticket prices inclusive of GST — the number on the poster is what you pay.
   * Most of the rest of the world adds tax at the till. Getting this wrong does not shift a
   * label; it moves what the customer is charged, by the rate.
   */
  inclusive?: boolean;

  /** How the levy is presented once intra- vs inter-state is known. */
  split?: TaxSplitKind;
}

/** Where and when a booking is happening, for matching rules. */
export interface TaxPlace {
  country?: string | null;
  /**
   * The PLACE OF SUPPLY. For admission to an event that is where the event is HELD —
   * s.12(6) of India's IGST Act, and the same principle in most VAT regimes.
   */
  region?: string | null;
  /**
   * Where the SELLER is registered. Compared against `region` to decide whether the sale
   * crosses a state border.
   *
   * Unknown means intra-state, which is the overwhelmingly common case for a venue event
   * and — because both presentations carry the same rate — cannot overcharge anyone. It can
   * only put the right amount under the wrong heading.
   */
  supplierRegion?: string | null;
  /**
   * The BUYER's state, and where the PLATFORM is registered.
   *
   * ── WHY A SECOND PAIR ──────────────────────────────────────────────────────────
   * Admission and the platform's booking fee are different supplies with different
   * place-of-supply rules, and using one pair for both is simply wrong.
   *
   *   admission     s.12(6): where the EVENT is held → `region` vs `supplierRegion`
   *   booking fee   s.12(2): where the RECIPIENT is → `customerRegion` vs `platformRegion`
   *
   * Confirmed against a real BookMyShow order for a Hyderabad cinema: the ticket is a
   * Telangana supply by a Telangana cinema, while the convenience fee is charged as
   * **IGST at 18%** — because the platform is registered in another state and the buyer is
   * in Telangana. The same order carries both presentations, which one pair of states cannot
   * produce.
   *
   * Both are optional. Unknown resolves to intra-state exactly as before, so nothing changes
   * for a deployment that does not capture them.
   */
  customerRegion?: string | null;
  platformRegion?: string | null;
  currency?: string | null;
  at?: Date;
}

/**
 * One kind of ticket in the order: what ONE costs, and how many.
 *
 * Units rather than a total, because a banded rate is decided per ticket. A scoped rule
 * refuses to rate an order that cannot be broken down this way rather than guessing.
 */
export interface AdmissionLine {
  unitPriceMinor: number;
  quantity: number;
  /** Matched against a rule's `category`. */
  category?: string | null;
}

/** One tax charged, itemised so a receipt can show it and an auditor can redo the sum. */
export interface TaxLine {
  label: string;
  rateBasisPoints: number;
  /** The amount the rate was applied to. */
  baseMinor: number;
  amountMinor: number;
  /**
   * What this line was levied on, and whether it sat inside the price.
   *
   * Stated rather than inferred. A caller wanting "how much did the booking fee cost in
   * total" was reduced to comparing `baseMinor` against the fee and guessing — which is
   * wrong the moment the tax is inclusive, because then the base is the fee MINUS its own
   * tax. Two fields remove the guess entirely.
   *
   * Not persisted on `BookingTaxLine`: the stored row keeps label, rate, base and amount,
   * which is what a receipt and an auditor need.
   */
  basis: TaxBaseKind;
  inclusive: boolean;
}

export interface TaxCalcResult {
  taxLines: TaxLine[];
  /** Every tax charged, whether it sat inside the price or was added to it. */
  taxMinor: number;
  /**
   * The part to ADD to the total — exclusive tax only.
   *
   * Inclusive tax is already inside the ticket price, so adding it would charge it twice.
   * Returned separately rather than left for each caller to work out, because "which of
   * these numbers do I add up" is precisely the question a money bug hides in.
   */
  taxAddedMinor: number;
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
 * Ordering decides two things: presentation on a receipt, and — for rules sharing a
 * `taxGroup` — which one wins. Two taxes at once is the normal case rather than an edge
 * case: Canada charges federal and provincial tax side by side.
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

/** Inclusive on both ends; a null bound is unbounded. Matched on ONE ticket's price. */
function inBand(rule: TaxRuleInput, line: AdmissionLine): boolean {
  const unit = Math.round(line.unitPriceMinor);
  if (rule.minUnitMinor != null && unit < rule.minUnitMinor) return false;
  if (rule.maxUnitMinor != null && unit > rule.maxUnitMinor) return false;
  return true;
}

/** Levied on the admission - the ticket base - whether or not also on the fee. */
function isTicketRule(rule: TaxRuleInput): boolean {
  return rule.appliesTo === 'TICKETS' || rule.appliesTo === 'TICKETS_AND_FEES';
}

/** Names one category rather than '*'. */
function namesCategory(rule: TaxRuleInput): boolean {
  const category = (rule.category ?? WILDCARD).trim();
  return category !== '' && category !== WILDCARD;
}

/**
 * A CLASSIFIED admission rule: one of a group of alternatives on the ticket base.
 *
 * ── WHY A GROUP MEANS "CLASSIFY OR REFUSE" ────────────────────────────────────────
 * A group on the ticket base exists for one reason: the rate depends on WHAT is being
 * admitted to - India's cinema, sporting and performance rates are alternatives in one
 * group. In such a group a '*' rule is a guess: it is what taxed every cinema ticket at 18%
 * when the cinema rules (written for category 'MOVIE') never matched the seat class the
 * booking passed as the category. So within a group on the ticket base only a rule that
 * NAMES the line's category may rate it, and a line no such rule rates is refused (see
 * `admissionClassificationGaps`) instead of falling to an assumed rate.
 *
 * Ungrouped rules are untouched: Canada's GST and PST on every ticket are not alternatives
 * and do not depend on what the ticket is for.
 */
function isClassifiedTicketRule(rule: TaxRuleInput): boolean {
  return isTicketRule(rule) && (rule.taxGroup ?? '').trim() !== '';
}

/** Why a ticket could not be rated. Both are refusals, never a default rate. */
export type TaxClassificationGapCode =
  /** The ticket (and its event) carry no tax category. The organizer fixes it. */
  | 'TAX_CLASSIFICATION_MISSING'
  /** It has one, but no active rule covers that category at this price. The platform fixes it. */
  | 'TAX_RULE_NOT_FOUND';

export interface TaxClassificationGap {
  code: TaxClassificationGapCode;
  /** The category the line carried, or null when it carried none. */
  category: string | null;
  unitPriceMinor: number;
  /** Which admission line, in the order the caller passed them. -1: no lines were passed. */
  lineIndex: number;
}

/**
 * Thrown when a market rates admissions by classification and a ticket cannot be rated.
 *
 * A distinct type, not an `Error` with a sentence, so the pricing service can turn it into a
 * refusal with a stable code while every other failure stays a 500.
 */
export class TaxClassificationError extends Error {
  constructor(readonly gaps: TaxClassificationGap[]) {
    super(
      gaps.some((g) => g.code === 'TAX_CLASSIFICATION_MISSING')
        ? 'A ticket in this order has no tax classification, and tax here depends on it.'
        : 'No tax rule covers the classification of a ticket in this order.',
    );
    this.name = 'TaxClassificationError';
  }

  /** The more actionable of the two, so a caller can report one code. */
  get code(): TaxClassificationGapCode {
    return this.gaps.some((g) => g.code === 'TAX_CLASSIFICATION_MISSING')
      ? 'TAX_CLASSIFICATION_MISSING'
      : 'TAX_RULE_NOT_FOUND';
  }
}

/**
 * The tickets in an order that the APPLICABLE rules cannot rate - empty when all can.
 *
 * `rules` must already be the rules that apply here and now (`selectTaxRules`). With no
 * classified admission rule among them - every environment today, GST being inactive - this
 * returns nothing and the order prices exactly as before. A zero-value line is never a gap:
 * there is nothing to tax on it, so a free ticket is not refused for want of a category.
 */
export function admissionClassificationGaps(
  rules: readonly TaxRuleInput[],
  lines: readonly AdmissionLine[],
): TaxClassificationGap[] {
  const classified = rules.filter(isClassifiedTicketRule);
  if (classified.length === 0) return [];
  const groups = [...new Set(classified.map((r) => (r.taxGroup ?? '').trim()))];

  const gaps: TaxClassificationGap[] = [];
  lines.forEach((line, lineIndex) => {
    if (Math.round(line.unitPriceMinor) * Math.round(line.quantity) <= 0) return;
    const category = line.category?.trim() || null;
    if (!category) {
      gaps.push({
        code: 'TAX_CLASSIFICATION_MISSING',
        category: null,
        unitPriceMinor: line.unitPriceMinor,
        lineIndex,
      });
      return;
    }
    const unrated = groups.some(
      (group) =>
        !classified.some(
          (r) =>
            (r.taxGroup ?? '').trim() === group &&
            namesCategory(r) &&
            matches(r.category, category) &&
            inBand(r, line),
        ),
    );
    if (unrated) {
      gaps.push({
        code: 'TAX_RULE_NOT_FOUND',
        category,
        unitPriceMinor: line.unitPriceMinor,
        lineIndex,
      });
    }
  });
  return gaps;
}

/**
 * Whether tax where and when this sale happens depends on a ticket's classification - so the
 * organizer must set one. False everywhere GST is inactive.
 */
export function requiresTaxClassification(rules: TaxRuleInput[], place: TaxPlace = {}): boolean {
  return selectTaxRules(rules, place).some(isClassifiedTicketRule);
}

/** The categories the applicable rules can rate - what is worth offering an organizer. */
export function ratedTaxCategories(rules: TaxRuleInput[], place: TaxPlace = {}): string[] {
  return [
    ...new Set(
      selectTaxRules(rules, place)
        .filter((r) => isClassifiedTicketRule(r) && namesCategory(r))
        .map((r) => (r.category ?? '').trim().toUpperCase()),
    ),
  ].sort();
}

/** Scoped = decided per ticket. Such a rule cannot be applied to an order total. */
function isScoped(rule: TaxRuleInput): boolean {
  const categorised = rule.category != null && rule.category.trim() !== WILDCARD;
  return rule.minUnitMinor != null || rule.maxUnitMinor != null || categorised;
}

/**
 * Whether the sale crosses a state border.
 *
 * Both sides must be known to answer yes. An unknown seller or venue state resolves to
 * intra-state, which is the common case and — since both presentations carry the same total
 * rate — changes the heading on the invoice and never the amount charged.
 */
function crossesStateBorder(rule: TaxRuleInput, place: TaxPlace | undefined): boolean {
  /*
    A FEE is the platform's own supply of service, and its place of supply is the RECIPIENT's
    location — not the venue's. A ticket to a Hyderabad cinema bought by somebody in Telangana
    is an intra-state admission; the booking fee on the same order is inter-state, because the
    platform is registered elsewhere. One order, two answers.
  */
  const isFee = rule.appliesTo === 'FEES';
  const supply = isFee ? place?.customerRegion : place?.region;
  const supplier = isFee ? place?.platformRegion : place?.supplierRegion;
  if (!supply?.trim() || !supplier?.trim()) return false;

  /*
    Compared through the alias table rather than by uppercasing both sides.

    The three fields feeding this are typed by three different people at three different
    times — a venue's region by an organizer, an organization's registered region during
    onboarding, and a buyer's state at checkout. "TG", "36" and "Telangana" are one place,
    and a string comparison makes them three. The failure is silent and goes one way only:
    every sale looks inter-state, so every rupee is attributed to the wrong government while
    the amount charged stays correct and nothing looks wrong to anybody.

    A region the table does not recognise still compares as itself, so a Canadian province
    is unaffected by any of this.
  */
  return !regionMatches(supply, supplier);
}

/**
 * One levy, as the lines it reaches the receipt as.
 *
 * India's dual GST is one rate collected by two governments. Intra-state it is halved into
 * CGST and SGST; inter-state the whole rate is IGST. The names are statutory rather than
 * ours, which is why they are derived here instead of typed into a rule's label.
 */
function splitComponents(
  rule: TaxRuleInput,
  rate: number,
  interState: boolean,
): { label: string; rateBasisPoints: number }[] {
  if ((rule.split ?? 'NONE') !== 'CGST_SGST') {
    return [{ label: rule.label, rateBasisPoints: rate }];
  }
  if (interState) return [{ label: 'IGST', rateBasisPoints: rate }];
  const half = Math.round(rate / 2);
  return [
    { label: 'CGST', rateBasisPoints: half },
    { label: 'SGST', rateBasisPoints: rate - half },
  ];
}

/**
 * Divide one tax amount between the components it is presented as, so they add back to it
 * EXACTLY.
 *
 * ── THE ONE ROUNDING POLICY ────────────────────────────────────────────────────────────
 * A levy's tax is worked out once, at its full rate, in integer minor units and rounded
 * once half-up (`Math.round` on a non-negative amount). Splitting comes afterwards and
 * never rounds the total again. It used to be the other way round for a levy added to the
 * price: each 9% half was rounded on its own, so a Rs 35.27 fee carried IGST of 635 paise
 * but CGST 317 + SGST 317 = 634, and the buyer's STATE moved the price by a paisa (QA
 * readiness F1: quote 103,960 vs booking 103,961 for one cart).
 *
 * Shares are proportional to each component's rate and allocated cumulatively, half-up, so
 * an odd paisa goes to the FIRST component: 635 at 9% + 9% is CGST 318 + SGST 317.
 */
export function splitTaxAmount(totalMinor: number, rates: readonly number[]): number[] {
  const total = Math.round(totalMinor);
  if (rates.length <= 1) return [total];
  const rateSum = rates.reduce((s, r) => s + r, 0);
  if (rateSum <= 0) {
    // A 0% levy: nothing to share out, but every component still gets its line.
    return rates.map((_, i) => (i === 0 ? total : 0));
  }
  const parts: number[] = [];
  let cumulativeRate = 0;
  let allocated = 0;
  rates.forEach((rate, i) => {
    cumulativeRate += rate;
    const upTo = i === rates.length - 1 ? total : Math.round((total * cumulativeRate) / rateSum);
    parts.push(upTo - allocated);
    allocated = upTo;
  });
  return parts;
}

function baseFor(
  rule: TaxRuleInput,
  netSubtotalMinor: number,
  customerFeeMinor: number,
  maintenanceMinor: number,
): number {
  switch (rule.appliesTo) {
    case 'TICKETS':
      return netSubtotalMinor;
    case 'FEES':
      return customerFeeMinor;
    case 'TICKETS_AND_FEES':
      return netSubtotalMinor + customerFeeMinor;
    /*
      A statutory maintenance charge is its own base, taxed only by a rule that names it.

      Deliberately NOT folded into TICKETS: nothing says such a charge is taxed at the
      admission rate, or taxed at all. Whether it is remains a TaxRule somebody writes on
      advice — this only makes it addressable, so the question can be answered by
      configuration instead of being answered by silence.
    */
    case 'MAINTENANCE':
      return maintenanceMinor;
    default:
      return 0;
  }
}

export interface TaxCalcInput {
  /** Ticket subtotal after any discount — a discount reduces the taxable amount. */
  netSubtotalMinor: number;
  /**
   * The subtotal BEFORE the discount. When it is larger than `netSubtotalMinor`, per-ticket
   * amounts from `admissionLines` (which are at list price) are scaled down by the same
   * proportion, so the discount reduces each ticket's taxable value. Absent: unchanged.
   */
  grossSubtotalMinor?: number;
  /**
   * The order broken into ticket kinds, when the caller knows it.
   *
   * Required for any SCOPED rule — one with a price band or a category — because such a rule
   * is decided per ticket. Absent, a scoped rule throws rather than rating a whole order in
   * one band. Unscoped rules are unaffected and still work off `netSubtotalMinor`, which is
   * what every caller did before bands existed.
   */
  admissionLines?: AdmissionLine[];
  /**
   * Only the fee the CUSTOMER pays. Fees the organizer absorbs are the organizer's own tax
   * matter and never appear on the customer's receipt, so taxing them here would invent a
   * charge nobody owes.
   */
  customerFeeMinor: number;
  /**
   * A statutory per-ticket maintenance charge for the whole order, if one applies.
   *
   * Only a rule with `appliesTo: 'MAINTENANCE'` reads it. Absent — which is every order
   * outside a regulated cinema jurisdiction — nothing changes anywhere in this file.
   */
  maintenanceMinor?: number;
  rules: TaxRuleInput[];
  place?: TaxPlace;
}

/**
 * Compute the tax lines for one booking.
 *
 * Each RULE rounds independently. That is not a shortcut — it is how a multi-tax
 * jurisdiction actually works: Canada computes GST and PST as separate amounts on the same
 * base, and each is rounded to the cent on its own. Rounding a combined rate once would
 * produce a total that neither tax authority's arithmetic agrees with.
 *
 * The halves of ONE rule are different: CGST and SGST are one rate presented two ways, so
 * the rule's amount is rounded once and then divided (`splitTaxAmount`), and the buyer pays
 * the same whether it reaches the invoice as CGST + SGST or as IGST.
 */
export function computeTax(input: TaxCalcInput): TaxCalcResult {
  const net = Math.max(0, Math.round(input.netSubtotalMinor));
  const custFee = Math.max(0, Math.round(input.customerFeeMinor));
  // Defaulted, so every existing caller — and every non-cinema order — is unchanged.
  const maintenance = Math.max(0, Math.round(input.maintenanceMinor ?? 0));
  const applicable = selectTaxRules(input.rules, input.place);

  /*
    What each rule is charged on, before deciding whether the tax sits inside that amount or
    on top of it.

    Accumulated per rule, but the GROUP contest is resolved per TICKET, which is the part
    that has to be right. A ₹90 seat and a ₹250 seat in one order fall in different bands of
    the same group, so collapsing the group once for the whole order would put one of them
    on the wrong rate.
  */
  const grossByRule = new Map<TaxRuleInput, number>();
  const addGross = (rule: TaxRuleInput, amount: number) =>
    grossByRule.set(rule, (grossByRule.get(rule) ?? 0) + amount);

  /*
    Named explicitly rather than by exclusion.

    These were "everything that is not FEES" and "everything that is not TICKETS", which
    partitioned the two bases correctly and silently swallowed a third the moment one
    existed: a MAINTENANCE rule satisfied BOTH predicates and would have been charged once
    on the ticket subtotal and again on the fee.
  */
  const ticketRules = applicable.filter(
    (r) => r.appliesTo === 'TICKETS' || r.appliesTo === 'TICKETS_AND_FEES',
  );
  const feeRules = applicable.filter(
    (r) => r.appliesTo === 'FEES' || r.appliesTo === 'TICKETS_AND_FEES',
  );
  const maintenanceRules = applicable.filter((r) => r.appliesTo === 'MAINTENANCE');

  if (input.admissionLines) {
    /*
      ── FAIL CLOSED ON AN UNCLASSIFIED OR UNMAPPED TICKET ─────────────────────────────
      Checked before anything is rated. A ticket the classified rules cannot rate used to fall
      to the group's '*' catch-all at 18%: an assumed rate on a real customer's money. It is
      now a refusal the caller turns into a clear code, and the organizer's readiness page
      reports the same gap before anybody reaches checkout.
    */
    const gaps = admissionClassificationGaps(applicable, input.admissionLines);
    if (gaps.length > 0) throw new TaxClassificationError(gaps);

    for (const line of input.admissionLines) {
      const lineTotal = Math.round(line.unitPriceMinor) * Math.round(line.quantity);
      if (lineTotal <= 0) continue;
      const taken = new Set<string>();
      for (const rule of ticketRules) {
        if (!matches(rule.category, line.category) || !inBand(rule, line)) continue;
        // A '*' rule in a group on the ticket base never rates a ticket - see
        // `isClassifiedTicketRule`. Only a rule naming the line's category does.
        if (isClassifiedTicketRule(rule) && !namesCategory(rule)) continue;
        const group = (rule.taxGroup ?? '').trim();
        if (group) {
          /*
            One rule per group per ticket.

            The list is priority-sorted, so the most specific rule an owner wrote wins and
            the catch-all beneath it does not stack. Without this the general 18% rule
            applied ON TOP of the banded cinema rate and every cinema ticket was taxed
            twice — found by pricing a real order against the real table, not by a unit test.
          */
          if (taken.has(group)) continue;
          taken.add(group);
        }
        addGross(rule, lineTotal);
      }
    }
    /*
      ── A DISCOUNT REDUCES WHAT EACH TICKET IS TAXED ON ─────────────────────────────
      The lines above are at LIST price, because a price band is decided by what the ticket
      costs. The taxable amount is what the buyer pays for it. Found by QA: a ₹100 coupon on a
      ₹799 seat lowered the total but left the GST base at the full ₹799, so every discounted
      booking's invoice overstated its tax.

      The discount is apportioned across the order in proportion to value (net ÷ gross), which
      is how it was applied to the subtotal. Band selection above is untouched. Only the
      admission portion is scaled — fee amounts for TICKETS_AND_FEES rules are added below.
    */
    const gross = input.grossSubtotalMinor ?? 0;
    if (gross > 0 && net < gross) {
      const paidShare = net / gross;
      for (const rule of ticketRules) {
        const atList = grossByRule.get(rule);
        if (atList !== undefined) grossByRule.set(rule, Math.round(atList * paidShare));
      }
    }
  } else {
    for (const rule of ticketRules) {
      /*
        A classified rule rates a ticket by what it is, and an order total says nothing about
        that. Refused with the same typed error as an unclassified ticket rather than applied
        to the subtotal - which is how a grouped catch-all would otherwise charge its rate.
      */
      if (isClassifiedTicketRule(rule)) {
        if (net <= 0) continue;
        throw new TaxClassificationError([
          {
            code: 'TAX_CLASSIFICATION_MISSING',
            category: null,
            unitPriceMinor: net,
            lineIndex: -1,
          },
        ]);
      }
      if (isScoped(rule)) {
        throw new Error(
          `Tax rule "${rule.label}" is scoped by price band or category, which can only be ` +
            'applied per ticket. The caller passed no admissionLines, so this order cannot ' +
            'be rated without guessing.',
        );
      }
      addGross(rule, baseFor(rule, net, 0, maintenance));
    }
  }

  /*
    Maintenance is one statutory charge for the whole order — quantity is already resolved
    into the amount — so like the fee it is contested once rather than per ticket.

    It is rated whether the charge is INCLUDED in the ticket price or ADDED to it. Inclusive
    tax on an included charge extracts rather than adds, which the shared inclusive/exclusive
    handling below already gets right; skipping it here would silently exempt the charge in
    every included-charge market.
  */
  if (maintenance > 0) {
    const takenMaintenance = new Set<string>();
    for (const rule of maintenanceRules) {
      const group = (rule.taxGroup ?? '').trim();
      if (group) {
        if (takenMaintenance.has(group)) continue;
        takenMaintenance.add(group);
      }
      addGross(rule, maintenance);
    }
  }

  // The fee is one supply for the whole order, so its group is contested once.
  if (custFee > 0) {
    const taken = new Set<string>();
    for (const rule of feeRules) {
      const group = (rule.taxGroup ?? '').trim();
      if (group) {
        if (taken.has(group)) continue;
        taken.add(group);
      }
      addGross(rule, custFee);
    }
  }

  const taxLines: TaxLine[] = [];
  let taxAddedMinor = 0;

  for (const rule of applicable) {
    const rate = Math.round(rule.rateBasisPoints);
    const grossMinor = grossByRule.get(rule) ?? 0;
    if (grossMinor <= 0) continue;

    /*
      Zero is a RATE, not an absence.

      India exempts recognised sporting fixtures at or below ₹500. That is a 0% line on the
      invoice, not a missing one — "we charged you no tax on this" and "we did not think
      about tax" are different statements, and only one of them is auditable. Worth emitting
      only for a rule somebody scoped deliberately.
    */
    if (rate <= 0 && !isScoped(rule)) continue;

    /*
      Inclusive: the price already contains the tax, so back it out rather than adding.
      taxable = gross × 10000 / (10000 + rate). Exclusive: the gross IS the taxable value.
    */
    const taxableMinor = rule.inclusive
      ? Math.round((grossMinor * 10_000) / (10_000 + rate))
      : grossMinor;

    const components = splitComponents(rule, rate, crossesStateBorder(rule, input.place));

    /*
      ── ONE LEVY, ONE AMOUNT, WHICHEVER WAY IT IS PRESENTED ──────────────────────────
      The rule's tax is computed ONCE at its full rate and only then divided into components
      (see `splitTaxAmount`), so CGST + SGST is always exactly the IGST the same sale would
      carry, and the buyer's state can change the headings on the invoice but never the price.

      Inclusive: the price already contains the tax, so the amount is `gross - taxable`,
      exact by construction - ₹250 at 18% leaves no orphan paisa belonging to nobody.
      Exclusive: the full rate on the taxable value, rounded once, half-up.

      Rounding each component on its own was the defect: on an added fee, 0.09 x 3,527 rounds
      to 317 twice (634) where 0.18 x 3,527 rounds to 635 once, and a quote and a booking for
      one cart differed by a paisa because one knew the buyer's state and one did not (QA
      readiness F1). Separate RULES - Canada's GST and PST - still round independently, as
      their authorities do; this concerns only the halves of one rate.
    */
    const levyMinor = rule.inclusive
      ? grossMinor - taxableMinor
      : Math.round((taxableMinor * rate) / 10_000);
    const amounts = splitTaxAmount(
      levyMinor,
      components.map((c) => c.rateBasisPoints),
    );

    components.forEach((component, i) => {
      taxLines.push({
        label: component.label,
        rateBasisPoints: component.rateBasisPoints,
        baseMinor: taxableMinor,
        amountMinor: amounts[i],
        basis: rule.appliesTo,
        inclusive: Boolean(rule.inclusive),
      });
      if (!rule.inclusive) taxAddedMinor += amounts[i];
    });
  }

  return {
    taxLines,
    taxMinor: taxLines.reduce((sum, l) => sum + l.amountMinor, 0),
    taxAddedMinor,
  };
}
