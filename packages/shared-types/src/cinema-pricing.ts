/**
 * The vocabulary of India cinema pricing regulation, shared by the API, the web apps and
 * the mobile client.
 *
 * ── WHY THESE ARE SHARED AND THE NUMBERS ARE NOT ───────────────────────────────────
 * Every client has to be able to RENDER a maintenance charge and say whether it was
 * included or added, so the words belong here. Not one amount, cap or ceiling does: those
 * are rows an administrator entered against a cited government order, resolved server-side,
 * and sent to clients already decided.
 *
 * A client that could compute a maintenance charge could disagree with the server about
 * what a customer owes, and the customer would be the one to find out.
 */

/** Which local body governs a cinema's address. Several orders band on this, not on city. */
export type LocalBodyType =
  'MUNICIPAL_CORPORATION' | 'MUNICIPALITY' | 'NAGAR_PANCHAYAT' | 'GRAM_PANCHAYAT' | 'OTHER';

/** Multiplex or single screen. Independent of climate. */
export type CinemaFormat = 'MULTIPLEX' | 'SINGLE_SCREEN' | 'SPECIAL_THEATRE';

/** Air-conditioned, air-cooled, or neither. Independent of format. */
export type ClimateType = 'AC' | 'AIR_COOLED' | 'NON_AC';

/**
 * How a statutory per-ticket maintenance charge relates to the published ticket price.
 *
 * INCLUDED means the price on the poster already contains it, so the charge is a
 * DISCLOSURE and the total does not move. ADDED means the total grows by it. Rendering one
 * as the other does not mis-label a line, it misstates what somebody is paying.
 */
export type MaintenanceTreatment =
  | 'NOT_APPLICABLE'
  | 'INCLUDED_IN_TICKET_PRICE'
  | 'ADDED_TO_TICKET_PRICE'
  /** Amount known, treatment not. Reviewable as a draft; never priceable. */
  | 'UNCONFIRMED';

/** What a jurisdiction permits by way of an online booking fee. */
export type OnlineFeePolicy =
  'ALLOWED' | 'CAPPED' | 'INCLUDED_IN_TICKET_PRICE' | 'PROHIBITED' | 'REQUIRES_APPROVAL';

/** Lifecycle of a pricing policy. History is superseded, never edited. */
export type CinemaPricingPolicyStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'DISABLED';

/**
 * The outcome of resolving a policy for one priced order.
 *
 * `NOT_REGULATED` is not a failure and not a gap: it means no active policy claims this
 * market, so ordinary platform pricing applies — which is every non-cinema event and every
 * market nobody has written an order for yet.
 */
export type PricingComplianceStatus =
  | 'NOT_REGULATED'
  | 'COMPLIANT'
  | 'POLICY_NOT_FOUND'
  | 'REQUIRES_APPROVAL'
  | 'PRICE_EXCEEDS_LIMIT'
  | 'ONLINE_FEE_NOT_ALLOWED'
  | 'INVALID_CINEMA_CLASSIFICATION'
  | 'POLICY_CONFIGURATION_ERROR';

/** Statuses that must not price a real customer order. */
export const BLOCKING_COMPLIANCE_STATUSES: readonly PricingComplianceStatus[] = [
  'POLICY_NOT_FOUND',
  'PRICE_EXCEEDS_LIMIT',
  'INVALID_CINEMA_CLASSIFICATION',
  'POLICY_CONFIGURATION_ERROR',
];

/**
 * Whether this outcome may proceed to a real booking.
 *
 * `REQUIRES_APPROVAL` is deliberately NOT blocking. It means the jurisdiction's online-fee
 * position is unconfirmed, and the safe response to that is to charge no online fee — not
 * to stop selling cinema tickets in the state. Charging nothing cannot overcharge anyone;
 * refusing to sell would be a bigger harm than the one being avoided.
 */
export function blocksBooking(status: PricingComplianceStatus): boolean {
  return BLOCKING_COMPLIANCE_STATUSES.includes(status);
}

/** What a client needs to render regulated pricing. Amounts already decided by the server. */
export interface RegulatoryPricing {
  /** Total maintenance for the order, in minor units. Zero when none applies. */
  maintenanceMinor: number;
  maintenanceTreatment: MaintenanceTreatment;
  /** Why the booking fee is what it is, so a client can say "not charged" and mean it. */
  onlineFeePolicy: OnlineFeePolicy | null;
  complianceStatus: PricingComplianceStatus;
  /** Cited order, for an organizer-facing compliance panel. Never shown to customers. */
  regulatoryReference?: string | null;
}
