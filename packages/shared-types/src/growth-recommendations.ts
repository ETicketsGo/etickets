/**
 * Deterministic, explainable growth recommendations (v2.0 WS4). Advisory only — every
 * item carries the supporting metric, a reason, a suggested action, and an evidence
 * level. NEVER modifies pricing, inventory, events, coupons or payments. Built from
 * the existing report/insights, so it works with AI disabled. Money is minor units.
 */
import { formatMinor } from './event-summary';

export type Evidence = 'strong' | 'moderate' | 'weak';

export interface GrowthRecommendation {
  key: string;
  title: string;
  /** The metric that supports this suggestion (shown to the organizer). */
  metric: string;
  reason: string;
  /** A suggested, human-performed action — advisory, never auto-applied. */
  action: string;
  evidence: Evidence;
}

export interface GrowthRecommendationInput {
  currency: string;
  ticketsSold: number;
  ticketsRemaining: number;
  grossTicketSalesMinor: number;
  refundsMinor: number;
  daysToEvent: number | null;
  salesByTicketType: { ticketType: string; quantity: number; grossMinor: number }[];
  couponRedemptions?: number;
  bundles?: { name: string; quantity: number; grossMinor: number }[];
}

const NEARLY_SOLD_OUT = 0.9;
const HIGH_REFUND_RATE = 0.1;
const LOW_UTILIZATION = 0.5;

export function deriveGrowthRecommendations(
  input: GrowthRecommendationInput,
): GrowthRecommendation[] {
  const recs: GrowthRecommendation[] = [];
  const capacity = input.ticketsSold + input.ticketsRemaining;
  const utilization = capacity > 0 ? input.ticketsSold / capacity : 0;
  const refundRate =
    input.grossTicketSalesMinor > 0 ? input.refundsMinor / input.grossTicketSalesMinor : 0;
  const near = input.daysToEvent !== null && input.daysToEvent <= 14;

  // Promote underperforming sessions (slow sales close to the event).
  if (near && input.ticketsRemaining > 0 && utilization < LOW_UTILIZATION) {
    recs.push({
      key: 'PROMOTE_SLOW',
      title: 'Promote this event',
      metric: `${Math.round(utilization * 100)}% sold, ${input.daysToEvent} day(s) to go`,
      reason: 'Sales are below half of capacity with the event approaching.',
      action: 'Share the event link and social posts, or add a limited-time coupon.',
      evidence: utilization < 0.3 ? 'strong' : 'moderate',
    });
  }

  // Highlight nearly sold-out inventory.
  if (utilization >= NEARLY_SOLD_OUT && input.ticketsRemaining > 0) {
    recs.push({
      key: 'NEARLY_SOLD_OUT',
      title: 'Nearly sold out',
      metric: `${input.ticketsRemaining} ticket(s) left (${Math.round(utilization * 100)}%)`,
      reason: 'Demand is strong and inventory is nearly exhausted.',
      action: 'Consider releasing additional capacity or adding a higher tier.',
      evidence: 'strong',
    });
  }

  // Review low-converting ticket types (a type selling far below the best seller).
  const sorted = [...input.salesByTicketType].sort((a, b) => b.quantity - a.quantity);
  if (sorted.length >= 2) {
    const best = sorted[0];
    const weak = sorted[sorted.length - 1];
    if (best.quantity >= 5 && weak.quantity <= Math.max(1, Math.floor(best.quantity * 0.15))) {
      recs.push({
        key: 'LOW_CONVERTING_TYPE',
        title: 'Review a low-converting ticket type',
        metric: `"${weak.ticketType}": ${weak.quantity} vs "${best.ticketType}": ${best.quantity}`,
        reason: 'One ticket type is selling far below your best performer.',
        action: 'Review its price, perks or visibility, or retire it.',
        evidence: 'moderate',
      });
    }
  }

  // Extend a successful coupon.
  if ((input.couponRedemptions ?? 0) >= 10) {
    recs.push({
      key: 'EXTEND_COUPON',
      title: 'Extend a successful coupon',
      metric: `${input.couponRedemptions} redemptions`,
      reason: 'A coupon is driving meaningful conversions.',
      action: 'Consider extending its window or raising its redemption cap.',
      evidence: 'moderate',
    });
  }

  // Review high refund activity.
  if (refundRate >= HIGH_REFUND_RATE) {
    recs.push({
      key: 'HIGH_REFUNDS',
      title: 'Review high refund activity',
      metric: `${Math.round(refundRate * 100)}% of gross refunded (${formatMinor(
        input.refundsMinor,
        input.currency,
      )})`,
      reason: 'Refunds are above the healthy threshold.',
      action: 'Check for scheduling, expectation or fulfilment issues.',
      evidence: refundRate >= 0.2 ? 'strong' : 'moderate',
    });
  }

  // Promote high-performing bundles.
  const topBundle = [...(input.bundles ?? [])].sort((a, b) => b.grossMinor - a.grossMinor)[0];
  if (topBundle && topBundle.quantity >= 5) {
    recs.push({
      key: 'PROMOTE_BUNDLE',
      title: 'Promote a high-performing bundle',
      metric: `"${topBundle.name}": ${topBundle.quantity} sold, ${formatMinor(
        topBundle.grossMinor,
        input.currency,
      )}`,
      reason: 'A bundle is converting well and lifts order value.',
      action: 'Feature it in your promotions and event page.',
      evidence: 'moderate',
    });
  }

  // Prepare additional check-in devices for a busy, imminent event.
  if (near && input.ticketsSold >= 500) {
    recs.push({
      key: 'CHECKIN_DEVICES',
      title: 'Prepare additional check-in devices',
      metric: `${input.ticketsSold} attendees, ${input.daysToEvent} day(s) to go`,
      reason: 'A large gate needs enough scanning throughput.',
      action: 'Register and pre-flight extra check-in devices ahead of the event.',
      evidence: 'moderate',
    });
  }

  return recs;
}
