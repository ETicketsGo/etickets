import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Refund-policy abstraction (ADR-043 §Phase 6, P5.3B). A DETERMINISTIC, VERSIONED decision on
 * whether — and how much of — a captured payment may be automatically refunded. The default
 * mode is MANUAL_ONLY: with no explicit product/finance policy, every refund is manual review
 * and nothing auto-executes. Amounts are server-authoritative; the policy NEVER computes from
 * client input, never approximates fee/tax splits, and never approves a partial refund. Any
 * uncertainty (check-in, settlement, provider-cancellation dependency) forces manual review.
 */
export type RefundPolicyMode =
  'MANUAL_ONLY' | 'FULL_GROSS' | 'TICKET_ONLY' | 'EVENT_CANCELLATION_FULL';

export interface BookingRefundPolicyContext {
  bookingId: string;
  bookingStatus: string;
  workflowState?: string;
  paymentStatus: string;
  paymentProvider: string;
  amountPaidMinor: number;
  currency: string;
  ticketIssued: boolean;
  ticketCheckedIn: boolean;
  sessionStarted: boolean;
  eventCancelled: boolean;
  customerCancellation: boolean;
  /** PROVIDER_AUTHORITATIVE workflows may need the provider booking cancelled before refund. */
  providerBookingStatus?: string;
  providerCancellationRequired?: boolean;
  providerCancellationSupported?: boolean;
  /** Whether organizer settlement/payout has already occurred (reversal territory). */
  settlementStatus?: string;
  requestedAt: string;
}

export interface BookingRefundPolicyDecision {
  eligible: boolean;
  refundType: 'FULL' | 'NONE' | 'MANUAL_REVIEW';
  refundableAmountMinor?: number;
  refundableCurrency?: string;
  inventoryResellable: boolean;
  providerCancellationRequired: boolean;
  settlementReversalRequired: boolean;
  requiresManualReview: boolean;
  reasonCode: string;
  policyVersion: string;
}

export interface BookingRefundPolicy {
  evaluate(context: BookingRefundPolicyContext): BookingRefundPolicyDecision;
}

@Injectable()
export class DefaultBookingRefundPolicy implements BookingRefundPolicy {
  constructor(private readonly config: ConfigService) {}

  get mode(): RefundPolicyMode {
    return this.config.get<RefundPolicyMode>('BOOKING_REFUND_POLICY_MODE', 'MANUAL_ONLY');
  }
  get version(): string {
    return this.config.get<string>('BOOKING_REFUND_POLICY_VERSION') ?? `${this.mode}:v1`;
  }

  evaluate(ctx: BookingRefundPolicyContext): BookingRefundPolicyDecision {
    const base = {
      inventoryResellable: false, // NEVER auto-restore inventory without an explicit policy
      refundableCurrency: ctx.currency,
      policyVersion: this.version,
    };
    const manual = (reasonCode: string): BookingRefundPolicyDecision => ({
      ...base,
      eligible: false,
      refundType: 'MANUAL_REVIEW',
      providerCancellationRequired: !!ctx.providerCancellationRequired,
      settlementReversalRequired: this.settled(ctx),
      requiresManualReview: true,
      reasonCode,
    });

    // Default + explicit MANUAL_ONLY → everything is reviewed by an operator.
    if (this.mode === 'MANUAL_ONLY') return manual('POLICY_MANUAL_ONLY');
    // Component-split policy is not finalized — refunding only the ticket needs finance sign-off.
    if (this.mode === 'TICKET_ONLY') return manual('POLICY_TICKET_ONLY_NOT_APPROVED');

    // ── Hard, universal blocks (apply to every automatic mode) ──
    if (!(ctx.paymentStatus === 'SUCCEEDED' || ctx.paymentStatus === 'CAPTURED')) {
      return { ...manual('PAYMENT_NOT_CAPTURED'), eligible: false, refundType: 'NONE' };
    }
    if (ctx.ticketCheckedIn) return manual('TICKET_CHECKED_IN'); // never auto-refund after check-in
    if (this.settlementUnknownOrDone(ctx)) return manual('SETTLEMENT_UNCERTAIN_OR_DONE');
    if (ctx.providerCancellationRequired && !ctx.providerCancellationSupported) {
      return manual('PROVIDER_CANCELLATION_REQUIRED_UNSUPPORTED');
    }

    // ── Mode-specific eligibility ──
    if (this.mode === 'EVENT_CANCELLATION_FULL') {
      if (!ctx.eventCancelled) return manual('POLICY_REQUIRES_EVENT_CANCELLATION');
    } else if (this.mode === 'FULL_GROSS') {
      if (!(ctx.eventCancelled || ctx.customerCancellation))
        return manual('NO_QUALIFYING_CANCELLATION');
    }

    // Eligible for a FULL gross refund of the captured amount (no component splitting).
    return {
      ...base,
      eligible: true,
      refundType: 'FULL',
      refundableAmountMinor: ctx.amountPaidMinor,
      providerCancellationRequired: !!ctx.providerCancellationRequired,
      settlementReversalRequired: false,
      requiresManualReview: false,
      reasonCode:
        this.mode === 'EVENT_CANCELLATION_FULL' ? 'EVENT_CANCELLATION_FULL' : 'CANCELLATION_FULL',
    };
  }

  private settled(ctx: BookingRefundPolicyContext): boolean {
    return ctx.settlementStatus === 'COMPLETED' || ctx.settlementStatus === 'PAID';
  }
  private settlementUnknownOrDone(ctx: BookingRefundPolicyContext): boolean {
    // Unknown settlement is treated as uncertain (fail closed); a completed payout needs reversal.
    return !ctx.settlementStatus || ctx.settlementStatus === 'UNKNOWN' || this.settled(ctx);
  }
}

export const BOOKING_REFUND_POLICY = Symbol('BOOKING_REFUND_POLICY');
