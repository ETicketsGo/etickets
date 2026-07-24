// Pure marketplace money math + Stripe Connect status mapping for the US/Stripe
// integration. Framework-free and unit-tested so the split, reserve, settlement,
// and account-status rules can be verified without a database or the Stripe SDK.
//
// Money is ALWAYS integer minor units (cents for USD). No floating point.

import type { ConnectOnboardingStatus, SettlementStatus } from './enums';

/** Booking money snapshot (as stored on Booking) needed to split a charge. */
export interface MarketplaceSplitInput {
  /** Ticket face value, net to the organizer before platform fees. */
  subtotalMinor: number;
  /** Fees the organizer bears (deducted from their proceeds). */
  organizerFeeMinor: number;
  /** Discount applied (borne by the organizer's proceeds). */
  discountMinor: number;
  /** Tax collected, if any (remitted by the platform; not organizer proceeds). */
  taxMinor?: number;
  /** What the customer actually pays (authoritative charge amount). */
  totalMinor: number;
}

export interface MarketplaceSplit {
  /** Authoritative amount charged to the customer (== input.totalMinor). */
  totalMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  /** ETicketsGo's retained gross margin (Stripe's processing fee is paid from this). */
  platformFeeMinor: number;
  /** The organizer's eligible proceeds — the base for the eventual transfer. */
  organizerNetMinor: number;
}

function assertInt(name: string, v: number): void {
  if (!Number.isInteger(v))
    throw new Error(`${name} must be an integer minor-unit amount, got ${v}`);
}

/**
 * Split a customer charge into the organizer's eligible proceeds and ETicketsGo's
 * retained platform fee, from the booking's snapshotted amounts.
 *
 * organizerNet = subtotal − organizerFee − discount   (clamped ≥ 0)
 * platformFee  = total − organizerNet                 (ETicketsGo margin; pays Stripe fee)
 *
 * Under Separate Charges & Transfers the platform collects `total`; `organizerNet`
 * is later moved to the connected account and `platformFee` is retained.
 */
export function computeMarketplaceSplit(input: MarketplaceSplitInput): MarketplaceSplit {
  const subtotalMinor = input.subtotalMinor;
  const taxMinor = input.taxMinor ?? 0;
  const totalMinor = input.totalMinor;
  for (const [k, v] of Object.entries({
    subtotalMinor,
    organizerFeeMinor: input.organizerFeeMinor,
    discountMinor: input.discountMinor,
    taxMinor,
    totalMinor,
  })) {
    assertInt(k, v as number);
    if ((v as number) < 0) throw new Error(`${k} must be ≥ 0, got ${v}`);
  }

  const organizerNetMinor = Math.max(
    0,
    subtotalMinor - input.organizerFeeMinor - input.discountMinor,
  );
  const platformFeeMinor = totalMinor - organizerNetMinor;
  if (platformFeeMinor < 0) {
    throw new Error(
      `platformFee would be negative (total ${totalMinor} < organizerNet ${organizerNetMinor}); ` +
        `the organizer cannot be owed more than the customer paid.`,
    );
  }
  return { totalMinor, subtotalMinor, taxMinor, platformFeeMinor, organizerNetMinor };
}

export interface SettlementPayableInput {
  /** Sum of organizerNet across the settlement's successful payments. */
  grossOrganizerNetMinor: number;
  /** Refunds attributable to those payments (organizer's share clawed back). */
  refundsMinor: number;
  /** Dispute losses/holds attributable to those payments. */
  disputesMinor: number;
  /** Already-transferred amount for this settlement (idempotent re-release). */
  priorTransferredMinor: number;
  /** Reserve withheld, in basis points (100 = 1%). Config-driven, never hardcoded. */
  reserveBps: number;
}

export interface SettlementPayable {
  /** Base owed before reserve: gross − refunds − disputes − priorTransferred (≥ 0). */
  baseMinor: number;
  reserveMinor: number;
  /** Amount to transfer now: base − reserve (≥ 0). */
  payableMinor: number;
}

/**
 * Recompute an organizer's payable amount immediately before a transfer. Deducts
 * refunds, disputes, and prior transfers, then withholds the configured reserve.
 * Always clamps to ≥ 0 so a net-negative settlement never produces a transfer.
 */
export function computeSettlementPayable(input: SettlementPayableInput): SettlementPayable {
  for (const [k, v] of Object.entries(input)) {
    assertInt(k, v);
    if (v < 0) throw new Error(`${k} must be ≥ 0, got ${v}`);
  }
  if (input.reserveBps > 10000)
    throw new Error(`reserveBps must be ≤ 10000, got ${input.reserveBps}`);

  const baseMinor = Math.max(
    0,
    input.grossOrganizerNetMinor -
      input.refundsMinor -
      input.disputesMinor -
      input.priorTransferredMinor,
  );
  const reserveMinor = Math.floor((baseMinor * input.reserveBps) / 10000);
  const payableMinor = Math.max(0, baseMinor - reserveMinor);
  return { baseMinor, reserveMinor, payableMinor };
}

/** Allowed settlement state transitions (the lifecycle guard). */
export const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  PENDING: ['HELD', 'ELIGIBLE', 'BLOCKED'],
  HELD: ['ELIGIBLE', 'BLOCKED'],
  ELIGIBLE: ['APPROVED', 'BLOCKED', 'HELD'],
  APPROVED: ['TRANSFER_PROCESSING', 'BLOCKED'],
  TRANSFER_PROCESSING: ['TRANSFERRED', 'FAILED'],
  TRANSFERRED: ['PARTIALLY_REFUNDED', 'REVERSED'],
  PARTIALLY_REFUNDED: ['REVERSED'],
  BLOCKED: ['ELIGIBLE', 'HELD', 'PENDING'],
  FAILED: ['APPROVED', 'BLOCKED'],
  REVERSED: [],
};

export function canTransitionSettlement(from: SettlementStatus, to: SettlementStatus): boolean {
  return SETTLEMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Only these statuses may be released (an authorised transfer may be initiated). */
export function isReleasableSettlementStatus(status: SettlementStatus): boolean {
  return status === 'APPROVED' || status === 'FAILED';
}

/** Minimal Stripe account shape needed to derive our onboarding status. */
export interface StripeAccountSnapshot {
  hasAccount: boolean;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsCurrentlyDue: string[];
  disabledReason?: string | null;
}

/**
 * Map a Stripe connected-account snapshot to our onboarding status. Pure so it can
 * be unit-tested against every capability combination without the Stripe SDK.
 */
export function mapStripeAccountToOnboardingStatus(
  a: StripeAccountSnapshot,
): ConnectOnboardingStatus {
  if (!a.hasAccount) return 'NOT_STARTED';
  if (a.disabledReason) {
    return a.disabledReason.startsWith('rejected') ? 'REJECTED' : 'DISABLED';
  }
  if (a.chargesEnabled && a.payoutsEnabled) {
    return a.requirementsCurrentlyDue.length > 0 ? 'RESTRICTED' : 'ENABLED';
  }
  if (a.detailsSubmitted) return 'PENDING_VERIFICATION';
  return 'ONBOARDING';
}

/** An organizer may receive settlements only when charges are enabled (policy). */
export function canReceiveSettlements(status: ConnectOnboardingStatus): boolean {
  return status === 'ENABLED' || status === 'RESTRICTED';
}

/** An organizer may sell paid tickets only when charges are enabled. */
export function canSellPaidTickets(chargesEnabled: boolean): boolean {
  return chargesEnabled === true;
}
