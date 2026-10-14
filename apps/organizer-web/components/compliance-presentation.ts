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
