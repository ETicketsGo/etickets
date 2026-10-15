import type {
  CinemaComplianceView,
  PilotReadinessCheck,
  SeatClassMapping,
} from '@eticketsgo/web-kit';

/**
 * How the compliance panel SAYS things. It decides nothing: every figure and every blocker
 * arrives from the server, and checkout enforces on its own.
 */

export type HeadlineTone = 'error' | 'warning' | 'success';

export interface ComplianceHeadline {
  tone: HeadlineTone;
  text: string;
  /** How many further current blockers sit behind the lead one. */
  more: number;
}

/**
 * The line the panel leads with.
 *
 * ── CURRENT BLOCKERS FIRST ─────────────────────────────────────────────────────────
 * The compliance summary used to name the first ticket type over its ceiling, and that was
 * often an old Rs 151 test ticket on a show that has already finished - while the real
 * reason nothing sold was an unmapped seat class on the shows still to come. The readiness
 * report's online-sales blockers are computed over upcoming shows only, with checkout's own
 * refusal, so they win. Without any, the server's summary stands (it ignores finished shows).
 */
export function complianceHeadline(
  view: Pick<CinemaComplianceView, 'summary' | 'status' | 'blocksPublishing'> &
    Partial<Pick<CinemaComplianceView, 'jurisdiction' | 'classification' | 'reasonCode'>>,
  checks: readonly PilotReadinessCheck[] | undefined,
): ComplianceHeadline {
  const current = (checks ?? []).filter((c) => c.section === 'SALES' && c.level === 'BLOCKED');
  if (current.length > 0) {
    return { tone: 'error', text: current[0]!.message, more: current.length - 1 };
  }
  const tone: HeadlineTone =
    view.status === 'REQUIRES_APPROVAL' ? 'warning' : view.blocksPublishing ? 'error' : 'success';
  return { tone, text: classificationSummary(view) ?? view.summary, more: 0 };
}

/**
 * The server says INVALID_CINEMA_CLASSIFICATION both when the cinema has no classification AND
 * when it has one but the order cannot be applied to it - in QA, a seat category with no
 * regulatory seat class (F3, READINESS-VERIFY.md). Its sentence always says "this cinema has not
 * been classified. Set its local body, format and climate type", which sent an exhibitor whose
 * fields WERE set to the wrong form. When the same response shows all three set, this says what
 * is actually left to check. Wording only: the status, and whether publishing is blocked, are the
 * server's.
 *
 * A server that sends `reasonCode` already says which of the two it is, and names the seat
 * category, so its own sentence stands; this guess is only for an older API.
 */
export function classificationSummary(
  view: Pick<CinemaComplianceView, 'status'> &
    Partial<Pick<CinemaComplianceView, 'jurisdiction' | 'classification' | 'reasonCode'>>,
): string | null {
  if (view.status !== 'INVALID_CINEMA_CLASSIFICATION') return null;
  if (view.reasonCode !== undefined) return null;
  const classified =
    !!view.jurisdiction?.localBodyType &&
    !!view.classification?.cinemaFormat &&
    !!view.classification?.climateType;
  if (!classified) return null;
  return 'Cannot publish: this cinema is classified, but the pricing order cannot be applied to it yet. Check that every seat category is mapped to a regulatory seat class (Seat classes, below).';
}

/** Prices on finished shows only. History, never a headline. */
export function splitPrices<T extends { upcoming?: boolean }>(
  prices: readonly T[],
): { current: T[]; history: T[] } {
  // `upcoming` absent (an older API) counts as current: showing too much is the safe error.
  return {
    current: prices.filter((p) => p.upcoming !== false),
    history: prices.filter((p) => p.upcoming === false),
  };
}

/**
 * What checkout does about the booking fee, in plain words.
 *
 * `maxMinor` is the server's own ceiling (null = ordinary platform fee schedule, 0 = held at
 * zero). Without it we fall back to the server's description.
 */
export function bookingFeeWording(
  fee: CinemaComplianceView['onlineFee'],
  formatMoney: (minor: number) => string,
): string {
  if (fee.maxMinor === undefined) return fee.description;
  if (fee.policy === 'UNRESOLVED') {
    return 'No pricing rule applies yet, so checkout holds the booking fee at 0 until the rule is configured.';
  }
  if (fee.maxMinor === 0) return `Checkout holds the booking fee at 0. ${fee.description}`;
  if (fee.maxMinor === null) {
    return 'No limit from the pricing order. Checkout charges the normal platform booking fee.';
  }
  return `Checkout charges the platform booking fee, never more than ${formatMoney(fee.maxMinor)}.`;
}

const CLASS_LABEL: Record<string, string> = {
  REGULAR: 'Regular',
  RECLINER: 'Recliner',
  PREMIUM: 'Premium',
  NON_PREMIUM: 'Non-premium',
};

/** True when the cinema's pricing order is known to have no rate row for the class. */
export function classHasNoRate(
  classHasRate: Record<string, boolean> | undefined,
  cls: string,
): boolean {
  return !!classHasRate && classHasRate[cls] === false;
}

/**
 * A plain warning when a seat category is set to a class this cinema's order has no rate row
 * for. Null when all is well or the answer is not known (older API).
 */
export function missingRateWarning(
  category: Pick<SeatClassMapping, 'name' | 'regulatoryClass' | 'classHasRate'>,
): string | null {
  const cls = category.regulatoryClass;
  if (!cls || !classHasNoRate(category.classHasRate, cls)) return null;
  return `The pricing order for this cinema has no ${CLASS_LABEL[cls] ?? cls} rate. ${category.name} has no price ceiling to be checked against and may be refused at checkout. Pick the class that matches the seat, or ask ETicketsGo to add the rate.`;
}

// ── Limits by seat class (walk 2026-10-15) ──────────────────────────────────────────

type ClassRate = NonNullable<CinemaComplianceView['classRates']>[number];

/** The class names an exhibitor reads; the API's keys stay keys. */
export function className(cls: string): string {
  return CLASS_LABEL[cls] ?? cls;
}

/**
 * Each class's limit in words: "up to Rs 150", "no rate here, cannot be sold".
 *
 * Walking QA, the panel read "Order: None applies / Maximum: Not recorded" for a Vijayawada
 * multiplex the Andhra Pradesh order covers, because a room with two classes resolves at state
 * level and states no single ceiling. Per class is how checkout prices a ticket, so it is how
 * the panel says it.
 */
export function classRateLines(
  rates: readonly ClassRate[] | undefined,
  formatMoney: (minor: number) => string,
): { cls: string; label: string; text: string; sellable: boolean }[] {
  return (rates ?? [])
    .filter((r) => r.regulated)
    .map((r) => ({
      cls: r.regulatoryClass,
      label: className(r.regulatoryClass),
      sellable: r.sellable,
      text: !r.sellable
        ? 'No rate here, so it cannot be sold online'
        : r.maxMinor != null
          ? `Up to ${formatMoney(r.maxMinor)}`
          : 'No maximum price set',
    }));
}

/** The order(s) a cinema is priced under, from the whole-room answer or else from the classes. */
export function orderReference(
  view: Pick<CinemaComplianceView, 'regulatoryReference' | 'status'> &
    Partial<Pick<CinemaComplianceView, 'classRates' | 'jurisdiction'>>,
): string {
  if (view.regulatoryReference) return view.regulatoryReference;
  const refs = [
    ...new Set(
      (view.classRates ?? [])
        .filter((r) => r.sellable && r.regulatoryReference)
        .map((r) => r.regulatoryReference as string),
    ),
  ];
  if (refs.length > 0) return refs.join(', ');
  // No rules for the state at all. Asked per class too, because an unmapped seat category makes
  // the whole-room answer a classification refusal before the region is even looked at.
  const rates = view.classRates ?? [];
  const noRules =
    view.status === 'POLICY_NOT_FOUND' ||
    (rates.length > 0 && rates.every((r) => r.status === 'POLICY_NOT_FOUND'));
  if (noRules) {
    const where = view.jurisdiction?.region || view.jurisdiction?.city || 'this area';
    return `No pricing rules on record for ${where} yet. Online sales stay closed until ETicketsGo adds them.`;
  }
  return 'None applies';
}

/**
 * Whether the cinema's type (local body, format, climate) matters here: only where an order
 * is on record that prices by it. Telangana has no rules at all, and a US cinema has no
 * order, so asking either to "set the format and climate type" sent people looking for a
 * field that would change nothing.
 */
export function classificationMatters(
  view: Pick<CinemaComplianceView, 'status'> &
    Partial<Pick<CinemaComplianceView, 'classRates' | 'reasonCode'>>,
): boolean {
  if (view.status === 'NOT_REGULATED' || view.status === 'POLICY_NOT_FOUND') return false;
  const rates = view.classRates ?? [];
  // Per class, the resolver says so directly: a class refused for want of a classification.
  if (rates.length > 0) return rates.some((r) => r.status === 'INVALID_CINEMA_CLASSIFICATION');
  return (
    view.status === 'INVALID_CINEMA_CLASSIFICATION' && view.reasonCode === 'CINEMA_NOT_CLASSIFIED'
  );
}

export interface PriceGroup {
  name: string;
  priceMinor: number;
  ok: boolean;
  reason: string | null;
  /** How many upcoming shows carry this price. */
  shows: number;
}

/**
 * One line per distinct price, with how many shows carry it.
 *
 * The panel listed every ticket type of every show: 93 lines for a cinema with three seat
 * categories and 31 shows, making the readiness page 7,900px tall on a phone. What an
 * exhibitor checks is "which prices am I charging, and is any of them over the limit".
 */
export function groupPrices(
  prices: readonly { name: string; priceMinor: number; ok: boolean; reason: string | null }[],
): PriceGroup[] {
  const groups = new Map<string, PriceGroup>();
  for (const p of prices) {
    const key = `${p.name}\u0000${p.priceMinor}\u0000${p.ok}\u0000${p.reason ?? ''}`;
    const g = groups.get(key);
    if (g) g.shows += 1;
    else groups.set(key, { ...p, shows: 1 });
  }
  // Problems first, then by name and price.
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name) || a.priceMinor - b.priceMinor,
  );
}

/** "Regular - up to Rs 150", for a seat class option. Plain where no order applies. */
export function classOptionLabel(
  cls: string,
  rates: readonly ClassRate[] | undefined,
  formatMoney: (minor: number) => string,
): string {
  const rate = (rates ?? []).find((r) => r.regulatoryClass === cls);
  if (!rate || !rate.regulated) return className(cls);
  if (!rate.sellable) return `${className(cls)} - no rate here, will not sell`;
  if (rate.maxMinor != null) return `${className(cls)} - up to ${formatMoney(rate.maxMinor)}`;
  return className(cls);
}

/**
 * A seat category whose own price is above the limit of the class it is mapped to.
 *
 * Mapping "Platinum Executive" (Rs 200) to Regular (up to Rs 150) is accepted - the mapping is
 * the operator's to make - but its seats would then never sell at their price. Said at the
 * moment of choosing, not at checkout.
 */
export function aboveClassLimit(
  category: Pick<SeatClassMapping, 'name' | 'regulatoryClass' | 'basePriceMinor'> & {
    classRates?: readonly ClassRate[];
  },
  formatMoney: (minor: number) => string,
): string | null {
  const cls = category.regulatoryClass;
  if (!cls) return null;
  const rate = (category.classRates ?? []).find((r) => r.regulatoryClass === cls);
  if (!rate?.sellable || rate.maxMinor == null) return null;
  if (category.basePriceMinor <= rate.maxMinor) return null;
  return `${category.name} is priced at ${formatMoney(category.basePriceMinor)}, above the ${formatMoney(rate.maxMinor)} limit for a ${className(cls)} seat. Its tickets will not sell at that price. Choose the class that matches the seat, or lower its price to ${formatMoney(rate.maxMinor)} or less.`;
}
