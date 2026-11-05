import {
  calculateFees,
  type FeeCalcInput,
  type FeeCalcResult,
  type FeeTier,
} from './fee-calculator';

/**
 * Platform fee overrides and waivers - the pure part.
 *
 * ── WHAT A POLICY CAN CHANGE, AND WHAT IT CANNOT ──────────────────────────────────────
 * A policy replaces the BOOKING (platform) fee, and only that. It is expressed as fee bands so
 * that `calculateFees` runs unchanged on it, which keeps three rules true for free:
 *
 *   - the payment processing line is still `bps * (net + booking fee)`. A waiver does not
 *     waive what the payment gateway charges;
 *   - tax is still computed afterwards, on whatever fee the customer is actually charged;
 *   - an order with nothing to pay (a FREE event, a 100% coupon) still has no fee at all,
 *     because `calculateFees` answers zero for a zero net subtotal before it reads any band.
 *
 * ── PRECEDENCE ───────────────────────────────────────────────────────────────────────
 * An EVENT policy, then an ORGANIZATION policy, then the platform schedule. A policy that does
 * not apply right now (outside its window, used up, switched off, or in another currency) is
 * skipped, so the next level answers - that is how expiry falls back to normal pricing with
 * nothing having to run at the moment it expires.
 *
 * ── AN OVERRIDE ONLY EVER LOWERS THE FEE ─────────────────────────────────────────────
 * Every kind is a reduction (waive, a reduced fixed fee, a reduced percentage). A fixed Rs 10
 * meant as a discount on a Rs 20 band would otherwise charge MORE than the schedule on a small
 * order whose band is Rs 5. So the customer pays the lower of the two, always.
 *
 * COMBINED is held to the same rule, compared on the ORDER's total booking fee: the policy's
 * percentage plus its fixed part times the paid tickets, against what the schedule charges the
 * same order (with the same ticket count, so a COMBINED schedule band is compared like for
 * like). A "3% + Rs 5 per ticket" policy on an order the schedule would charge less is not
 * applied, and the order is priced by the schedule. FIXED_PER_TICKET is compared the same way,
 * and so is any optional minimum or maximum: the comparison is on the whole-order fee AFTER
 * those limits, so a policy minimum that would lift an order above the schedule is not applied.
 */

export type FeePolicyScope = 'EVENT' | 'ORGANIZATION';
export type FeePolicyKind = 'WAIVE' | 'FIXED' | 'PERCENT' | 'COMBINED' | 'FIXED_PER_TICKET';
export type FeePolicyStatus = 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'EXHAUSTED';

/** The terms of a policy, as stored. */
export interface FeePolicyTerms {
  kind: FeePolicyKind | string;
  feeMinor?: number | null;
  percentBps?: number | null;
  minFeeMinor?: number | null;
  maxFeeMinor?: number | null;
}

/** A stored policy, as much of it as selection needs. */
export interface FeePolicyRow extends FeePolicyTerms {
  id: string;
  scope: FeePolicyScope | string;
  eventId: string | null;
  organizationId: string;
  currency: string | null;
  startsAt: Date;
  endsAt: Date | null;
  maxOrders: number | null;
  usedOrders: number;
  status: FeePolicyStatus | string;
  version: number;
  createdAt?: Date;
}

/** What a sale is, for choosing a policy. */
export interface FeePolicyContext {
  eventId?: string | null;
  organizationId?: string | null;
  /** The instant the sale is priced at. */
  at: Date;
}

/** The policy a booking was priced under, as it is snapshotted. */
export interface AppliedFeePolicy {
  id: string;
  kind: FeePolicyKind;
  scope: FeePolicyScope;
  version: number;
  /** Null means unlimited. A limited policy reserves one order per hold. */
  maxOrders: number | null;
}

/**
 * The single band a policy charges.
 *
 * WAIVE is an explicit zero band, NOT an empty list: an empty list means "nothing configured"
 * everywhere else and falls back to the default schedule - which would charge the fee the
 * waiver exists to remove.
 */
export function policyFeeTiers(terms: FeePolicyTerms): FeeTier[] {
  switch (terms.kind) {
    case 'WAIVE':
      return [{ minMinor: 0, maxMinor: null, feeMinor: 0, type: 'FLAT' }];
    case 'FIXED':
      return [
        { minMinor: 0, maxMinor: null, feeMinor: Math.max(0, terms.feeMinor ?? 0), type: 'FLAT' },
      ];
    case 'PERCENT':
      return [
        {
          minMinor: 0,
          maxMinor: null,
          feeMinor: 0,
          type: 'PERCENT',
          percentBps: Math.max(0, terms.percentBps ?? 0),
          minFeeMinor: terms.minFeeMinor ?? null,
          maxFeeMinor: terms.maxFeeMinor ?? null,
        },
      ];
    case 'COMBINED':
      // A share of the order plus a fixed amount per paid ticket, optionally held between a
      // minimum and a maximum for the whole order (both unset by default).
      return [
        {
          minMinor: 0,
          maxMinor: null,
          feeMinor: Math.max(0, terms.feeMinor ?? 0),
          type: 'COMBINED',
          percentBps: Math.max(0, terms.percentBps ?? 0),
          minFeeMinor: terms.minFeeMinor ?? null,
          maxFeeMinor: terms.maxFeeMinor ?? null,
        },
      ];
    case 'FIXED_PER_TICKET':
      // A fixed amount for each paid ticket, with the same optional whole-order limits.
      return [
        {
          minMinor: 0,
          maxMinor: null,
          feeMinor: Math.max(0, terms.feeMinor ?? 0),
          type: 'FIXED_PER_TICKET',
          percentBps: null,
          minFeeMinor: terms.minFeeMinor ?? null,
          maxFeeMinor: terms.maxFeeMinor ?? null,
        },
      ];
    default:
      // An unknown kind must never price anything: refuse rather than guess.
      throw new Error(`Unknown platform fee policy kind '${String(terms.kind)}'.`);
  }
}

/** Whether a policy can price a sale in `currency` at `at`. Status, window, limit, currency. */
export function feePolicyApplies(p: FeePolicyRow, currency: string, at: Date): boolean {
  if (p.status !== 'ACTIVE') return false;
  if (p.startsAt.getTime() > at.getTime()) return false;
  // `endsAt` is exclusive: a policy ending at midnight does not price a sale at midnight.
  if (p.endsAt && p.endsAt.getTime() <= at.getTime()) return false;
  if (p.maxOrders != null && p.usedOrders >= p.maxOrders) return false;
  if (p.currency && p.currency.trim().toUpperCase() !== currency.trim().toUpperCase()) return false;
  return true;
}

/**
 * The policy that prices this sale, or null for the platform schedule.
 *
 * Event first, then organization. Within one level the service never lets two live policies
 * overlap, so a tie can only come from bad data; the newest wins so the answer is at least
 * deterministic.
 */
export function selectFeePolicy<P extends FeePolicyRow>(
  policies: P[],
  currency: string,
  ctx: FeePolicyContext,
): P | null {
  const live = policies
    .filter((p) => feePolicyApplies(p, currency, ctx.at))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  if (ctx.eventId) {
    const forEvent = live.find((p) => p.scope === 'EVENT' && p.eventId === ctx.eventId);
    if (forEvent) return forEvent;
  }
  if (ctx.organizationId) {
    const forOrg = live.find(
      (p) => p.scope === 'ORGANIZATION' && p.organizationId === ctx.organizationId,
    );
    if (forOrg) return forOrg;
  }
  return null;
}

export function appliedFeePolicy(p: FeePolicyRow): AppliedFeePolicy {
  return {
    id: p.id,
    kind: p.kind as FeePolicyKind,
    scope: p.scope as FeePolicyScope,
    version: p.version,
    maxOrders: p.maxOrders,
  };
}

/** The fee result, plus what the schedule would have charged and how much the policy took off. */
export interface FeePolicyOutcome {
  fees: FeeCalcResult;
  /** Null when no policy applied. */
  policy: AppliedFeePolicy | null;
  /** The schedule's booking fee for this order. Null when no policy applied. */
  baseBookingFeeMinor: number | null;
  /** Schedule fee minus policy fee, never negative. Null when no policy applied. */
  feeWaivedMinor: number | null;
}

/**
 * `calculateFees` under the schedule and, when a policy applies, under the policy - and the
 * lower of the two booking fees wins (an override only ever lowers the fee; see the top).
 *
 * Both results come from the same calculator with the same inputs, so whichever is returned is
 * internally consistent: its payment fee, fee split and total all belong to its booking fee.
 */
export function calculateFeesWithPolicy(
  input: Omit<FeeCalcInput, 'tiers'> & {
    baseTiers: FeeTier[];
    policy: (FeePolicyTerms & { applied: AppliedFeePolicy }) | null;
  },
): FeePolicyOutcome {
  const { baseTiers, policy, ...rest } = input;
  const base = calculateFees({ ...rest, tiers: baseTiers });
  if (!policy) {
    return { fees: base, policy: null, baseBookingFeeMinor: null, feeWaivedMinor: null };
  }
  const overridden = calculateFees({ ...rest, tiers: policyFeeTiers(policy) });
  /*
    The policy is not recorded as having priced an order it did not change for the better:
    one with nothing to pay (a FREE event, a 100% coupon - the fee is zero either way), or one
    where the schedule is already cheaper. Recording it would spend one of a limited policy's
    orders on a sale it gave nothing to.
  */
  if (base.netSubtotalMinor === 0 || overridden.bookingFeeMinor > base.bookingFeeMinor) {
    return { fees: base, policy: null, baseBookingFeeMinor: null, feeWaivedMinor: null };
  }
  return {
    fees: overridden,
    policy: policy.applied,
    baseBookingFeeMinor: base.bookingFeeMinor,
    feeWaivedMinor: base.bookingFeeMinor - overridden.bookingFeeMinor,
  };
}

/**
 * Whether two policy windows share any instant from `now` on.
 *
 * Only the future matters: a window that has already closed cannot conflict with anything, and
 * a policy that started last month and runs on is live from now on.
 */
export function windowsOverlap(
  a: { startsAt: Date; endsAt: Date | null },
  b: { startsAt: Date; endsAt: Date | null },
  now: Date,
): boolean {
  const start = (s: Date) => Math.max(s.getTime(), now.getTime());
  const end = (e: Date | null) => (e ? e.getTime() : Number.POSITIVE_INFINITY);
  const aStart = start(a.startsAt);
  const bStart = start(b.startsAt);
  const aEnd = end(a.endsAt);
  const bEnd = end(b.endsAt);
  if (aStart >= aEnd || bStart >= bEnd) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Two policies at the same target could both price one sale if their currencies could. */
export function currenciesCollide(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** What a policy is right now, for the console: stored status with time and usage applied. */
export function effectiveFeePolicyStatus(
  p: Pick<FeePolicyRow, 'status' | 'startsAt' | 'endsAt' | 'maxOrders' | 'usedOrders'>,
  now: Date,
): 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'EXHAUSTED' | 'INACTIVE' {
  if (p.status === 'INACTIVE') return 'INACTIVE';
  if (p.endsAt && p.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (p.status === 'EXPIRED') return 'EXPIRED';
  if (p.status === 'EXHAUSTED' || (p.maxOrders != null && p.usedOrders >= p.maxOrders)) {
    return 'EXHAUSTED';
  }
  if (p.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'ACTIVE';
}
