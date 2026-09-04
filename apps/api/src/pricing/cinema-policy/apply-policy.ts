import type { MaintenanceTreatment, PricingComplianceStatus } from '@eticketsgo/shared-types';
import type { PolicyResolution } from './cinema-pricing-policy.resolver';

/**
 * What a resolved policy does to the money.
 *
 * ── THE TWO THINGS IT DECIDES ──────────────────────────────────────────────────────
 * A per-ticket maintenance charge, and whether the platform's own booking fee is allowed to
 * stand. Nothing else — tax stays with the tax engine, fee bands stay with the fee tiers,
 * and this only says how much of them survives contact with a government order.
 *
 * ── WHY MAINTENANCE IS PER TICKET AND NOT PER ORDER ────────────────────────────────
 * The orders that exist are written per ticket. Two seats is twice the charge, and a cart of
 * one ₹90 seat and one ₹250 seat is still two tickets and still two charges — the amount does
 * not scale with the price. The caller therefore passes a ticket COUNT, not a subtotal.
 */
export interface PolicyEffect {
  /** Maintenance for the whole order. Zero when none applies. */
  maintenanceMinor: number;
  maintenanceTreatment: MaintenanceTreatment;
  /**
   * How much maintenance ADDS to what the customer pays.
   *
   * Zero when the charge is already inside the ticket price. The distinction is the entire
   * point of the treatment: `maintenanceMinor` is what is disclosed, `maintenanceAddedMinor`
   * is what moves the total, and conflating them double-charges every included-charge market.
   */
  maintenanceAddedMinor: number;
  /** The tax category a TaxRule must name to tax the charge, if the policy states one. */
  maintenanceTaxCategory: string | null;
  /**
   * The most the platform may charge as a booking fee, in minor units.
   *
   * `null` means unrestricted — the fee tiers decide, exactly as before. `0` means the fee
   * is not permitted, which is a real answer and not a missing one.
   */
  maxOnlineFeeMinor: number | null;
  /** Restated so a caller does not have to re-derive it from the resolution. */
  complianceStatus: PricingComplianceStatus;
  /** One sentence, for an audit entry and an organizer-facing panel. */
  explanation: string;
}

/**
 * Turn a resolution and a ticket count into the amounts that follow from it.
 *
 * Pure. Given the same resolution and count it returns the same numbers, which is what lets
 * a concurrent pair of bookings on one show be shown to price identically.
 */
export function applyPolicy(resolution: PolicyResolution, ticketCount: number): PolicyEffect {
  const { policy, status, explanation } = resolution;

  /*
    Nothing regulated applies. Everything behaves exactly as it did before this subsystem
    existed — no maintenance, and no ceiling on the platform fee. This is the path every
    non-cinema event and every unlisted market takes.
  */
  if (status === 'NOT_REGULATED') {
    return {
      maintenanceMinor: 0,
      maintenanceTreatment: 'NOT_APPLICABLE',
      maintenanceAddedMinor: 0,
      maintenanceTaxCategory: null,
      maxOnlineFeeMinor: null,
      complianceStatus: status,
      explanation,
    };
  }

  /*
    Regulated, and NO policy resolved — not found, ambiguous, or the cinema unclassified.

    The ceiling is ZERO, not `null`. This was written as `null` and a test caught it, which
    is the whole reason the test exists: `null` means "unrestricted", so a market that had
    been declared regulated but whose rule was missing would have fallen straight through to
    the platform's ordinary fee schedule — the exact silent non-compliance this subsystem is
    for. Absence of a rule is never permission.

    The caller separately refuses to complete such a booking; this makes the money safe even
    if some future path forgets to.
  */
  if (!policy) {
    return {
      maintenanceMinor: 0,
      maintenanceTreatment: 'NOT_APPLICABLE',
      maintenanceAddedMinor: 0,
      maintenanceTaxCategory: null,
      maxOnlineFeeMinor: 0,
      complianceStatus: status,
      explanation,
    };
  }

  const perTicket =
    policy.maintenanceTreatment === 'NOT_APPLICABLE' ? 0 : policy.maintenanceChargeMinor;
  const maintenanceMinor = perTicket * Math.max(0, ticketCount);

  /*
    Included means the published price already contains it. The customer's total does not
    move; the charge is disclosed so the invoice can state it, exactly as an inclusive tax
    is stated below a total rather than added above one.
  */
  const maintenanceAddedMinor =
    policy.maintenanceTreatment === 'ADDED_TO_TICKET_PRICE' ? maintenanceMinor : 0;

  return {
    maintenanceMinor,
    maintenanceTreatment: policy.maintenanceTreatment,
    maintenanceAddedMinor,
    maintenanceTaxCategory: policy.maintenanceTaxCategory,
    maxOnlineFeeMinor: onlineFeeCeiling(policy.onlineFeePolicy, policy.onlineFeeCapMinor),
    complianceStatus: status,
    explanation,
  };
}

/**
 * The ceiling a jurisdiction places on the platform's booking fee.
 *
 * ── WHY `REQUIRES_APPROVAL` MEANS ZERO AND NOT "PROCEED" ───────────────────────────
 * It means nobody has read and recorded the current order for this state. The platform's
 * global fee schedule is not evidence that charging it there is lawful, and helping itself
 * to a fee on that basis is the single most likely way this system produces a real
 * compliance failure. Charging nothing cannot overcharge anybody; it costs revenue until
 * somebody records the position, which is the correct thing to be losing.
 *
 * ── AND WHY IT DOES NOT BLOCK THE SALE ─────────────────────────────────────────────
 * Refusing to sell cinema tickets in a whole state because a fee schedule is unconfirmed
 * would be a larger harm than the one being avoided. Sell the ticket, charge no fee, and
 * say so on the organizer's compliance panel.
 */
function onlineFeeCeiling(policy: string, capMinor: number | null): number | null {
  switch (policy) {
    case 'ALLOWED':
      return null;
    case 'CAPPED':
      // A CAPPED policy with no cap is refused upstream as a configuration error; zero here
      // is the fail-closed reading in case one ever reaches this point.
      return capMinor ?? 0;
    case 'INCLUDED_IN_TICKET_PRICE':
    case 'PROHIBITED':
    case 'REQUIRES_APPROVAL':
      return 0;
    default:
      // An unrecognised policy value is a configuration error, not permission.
      return 0;
  }
}

/**
 * Whether an organizer's ticket price is inside the policy's band.
 *
 * Separate from `applyPolicy` because it answers a different question at a different time:
 * this runs when an organizer sets a price, and the result blocks publishing rather than
 * changing a total. Nothing here ever adjusts a price — silently repricing an organizer's
 * ticket to fit a ceiling would be worse than refusing it.
 */
export function checkTicketPrice(
  resolution: PolicyResolution,
  unitPriceMinor: number,
): { ok: boolean; status: PricingComplianceStatus; reason: string | null } {
  const policy = resolution.policy;
  if (!policy || resolution.status === 'NOT_REGULATED') {
    return { ok: true, status: resolution.status, reason: null };
  }
  if (policy.ticketPriceMaxMinor != null && unitPriceMinor > policy.ticketPriceMaxMinor) {
    return {
      ok: false,
      status: 'PRICE_EXCEEDS_LIMIT',
      // Inclusive bound: a price exactly AT the ceiling is permitted. "Up to ₹150" includes
      // ₹150, and an off-by-one here rejects lawful prices.
      reason: `${policy.regulatoryReference} permits at most ${policy.ticketPriceMaxMinor / 100} for this classification; ${unitPriceMinor / 100} exceeds it.`,
    };
  }
  if (policy.ticketPriceMinMinor != null && unitPriceMinor < policy.ticketPriceMinMinor) {
    return {
      ok: false,
      status: 'PRICE_EXCEEDS_LIMIT',
      reason: `${policy.regulatoryReference} requires at least ${policy.ticketPriceMinMinor / 100} for this classification.`,
    };
  }
  return { ok: true, status: resolution.status, reason: null };
}
