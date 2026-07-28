import { Injectable } from '@nestjs/common';
import {
  CompensationType,
  FINANCIAL_ACTIONS,
  SAFE_NON_FINANCIAL_ACTIONS,
  type CompensationAction,
  type CompensationPlan,
} from './compensation-types';
import {
  choosePaymentCompensation,
  type PaymentCapabilityView,
  type PaymentState,
} from './payment-capability';

/**
 * The discrepancy a compensation plan is built from (ADR-043 §17). Every field is a
 * server-derived fact — no client input. The planner is PURE + deterministic and NEVER
 * executes anything: it maps a discrepancy to the required durable actions and whether they
 * are safe to auto-execute in P5.3A.
 */
export interface CompensationContext {
  bookingId: string;
  reasonCode: string;
  redisLockPresent?: boolean;
  localHoldActive?: boolean;
  paymentSucceeded?: boolean;
  payment?: PaymentState;
  paymentCapabilities?: PaymentCapabilityView;
  providerReservationId?: string;
  providerBookingId?: string;
  providerCapabilities?: { supportsCancel: boolean; idempotentCancellation: boolean };
  /** Definitive provider outcome after payment, when known. */
  providerOutcome?: 'CONFIRMED' | 'REJECTED' | 'SOLD_OUT' | 'AMBIGUOUS' | 'EXPIRED';
  paymentCreatePermanentlyFailed?: boolean;
  localConfirmationFailed?: boolean;
  localConfirmationRetriesExhausted?: boolean;
  redisFinalizeFailed?: boolean;
  captureFailed?: boolean;
  ticketIssuanceFailed?: boolean;
  duplicateCallback?: boolean;
}

@Injectable()
export class CompensationPlanner {
  /** Deterministically classify a discrepancy into required compensation actions (A–H). */
  plan(ctx: CompensationContext): CompensationPlan {
    // H. Duplicate callback / replay — idempotent success, no compensation.
    if (ctx.duplicateCallback) {
      return this.empty('DUPLICATE_CALLBACK', 'DUPLICATE_CALLBACK_NO_COMPENSATION');
    }

    // E. Local booking confirmed, Redis finalize failed → just clean up the lock.
    if (ctx.redisFinalizeFailed) {
      return this.of('REDIS_FINALIZE_FAILED', [
        this.action(CompensationType.REDIS_LOCK_RELEASE, 'REDIS_FINALIZE_FAILED', ctx.bookingId),
      ]);
    }

    // G. Ticket issuance failed post-confirmation → retry via the existing outbox path, not a
    //    compensation record and NEVER an automatic refund.
    if (ctx.ticketIssuanceFailed) {
      return this.empty('TICKET_ISSUANCE_FAILED', 'RETRY_TICKET_VIA_OUTBOX');
    }

    // A. Redis lock acquired, local hold failed (pre-payment) → release the lock.
    if (ctx.redisLockPresent && !ctx.localHoldActive && !ctx.paymentSucceeded) {
      return this.of('LOCK_OK_HOLD_FAILED', [
        this.action(CompensationType.REDIS_LOCK_RELEASE, 'LOCK_OK_HOLD_FAILED', ctx.bookingId),
      ]);
    }

    // B. Local hold succeeded, payment creation permanently failed → release hold (+ cancel an
    //    unconfirmed provider reservation if present).
    if (ctx.paymentCreatePermanentlyFailed) {
      const actions: CompensationAction[] = [
        this.action(CompensationType.LOCAL_HOLD_RELEASE, 'PAYMENT_CREATE_FAILED', ctx.bookingId),
      ];
      if (ctx.providerReservationId) {
        actions.push(
          this.action(
            CompensationType.PROVIDER_RESERVATION_CANCEL,
            'PAYMENT_CREATE_FAILED',
            ctx.providerReservationId,
          ),
        );
      }
      return this.of('HOLD_OK_PAYMENT_CREATE_FAILED', actions);
    }

    // C. Payment succeeded, provider rejected / sold out → plan money-back + cleanup. Money
    //    actions are planned but NOT auto-executed in P5.3A.
    if (
      ctx.paymentSucceeded &&
      (ctx.providerOutcome === 'REJECTED' || ctx.providerOutcome === 'SOLD_OUT')
    ) {
      const actions: CompensationAction[] = [];
      if (ctx.payment && ctx.paymentCapabilities) {
        const money = choosePaymentCompensation(ctx.payment, ctx.paymentCapabilities);
        actions.push(this.action(money, 'PAYMENT_SUCCEEDED_PROVIDER_REJECTED', ctx.bookingId));
      } else {
        actions.push(
          this.action(CompensationType.MANUAL_REVIEW, 'PAYMENT_STATE_UNKNOWN', ctx.bookingId),
        );
      }
      if (ctx.providerReservationId) {
        actions.push(
          this.action(
            CompensationType.PROVIDER_RESERVATION_CANCEL,
            'PROVIDER_REJECTED',
            ctx.providerReservationId,
          ),
        );
      }
      actions.push(
        this.action(CompensationType.LOCAL_HOLD_RELEASE, 'PROVIDER_REJECTED', ctx.bookingId),
      );
      if (ctx.redisLockPresent) {
        actions.push(
          this.action(CompensationType.REDIS_LOCK_RELEASE, 'PROVIDER_REJECTED', ctx.bookingId),
        );
      }
      return this.of('PAYMENT_SUCCEEDED_PROVIDER_REJECTED', actions);
    }

    // D. Provider confirmed, local confirmation failed → retry locally; if exhausted, escalate.
    if (ctx.providerOutcome === 'CONFIRMED' && ctx.localConfirmationFailed) {
      if (!ctx.localConfirmationRetriesExhausted) {
        return this.of('LOCAL_CONFIRMATION_FAILED_AFTER_PROVIDER_CONFIRM', [
          this.action(
            CompensationType.LOCAL_CONFIRMATION_RETRY,
            'LOCAL_CONFIRM_RETRY',
            ctx.bookingId,
          ),
        ]);
      }
      const actions: CompensationAction[] = [];
      if (ctx.providerBookingId && ctx.providerCapabilities?.supportsCancel) {
        actions.push(
          this.action(
            CompensationType.PROVIDER_BOOKING_CANCEL,
            'LOCAL_CONFIRM_EXHAUSTED',
            ctx.providerBookingId,
          ),
        );
      }
      // Cancellation certainty absent → manual review before any money movement.
      actions.push(
        this.action(CompensationType.MANUAL_REVIEW, 'LOCAL_CONFIRM_EXHAUSTED', ctx.bookingId),
      );
      return this.of('LOCAL_CONFIRMATION_EXHAUSTED_AFTER_PROVIDER_CONFIRM', actions);
    }

    // F. Provider confirmed, payment capture failed → capture semantics are not assumed.
    if (ctx.captureFailed) {
      return this.of('PROVIDER_CONFIRMED_CAPTURE_FAILED', [
        this.action(CompensationType.MANUAL_REVIEW, 'CAPTURE_FAILED', ctx.bookingId),
      ]);
    }

    // Ambiguous provider state → never guess; manual review.
    if (ctx.providerOutcome === 'AMBIGUOUS') {
      return this.of('PROVIDER_CONFIRMATION_AMBIGUOUS', [
        this.action(CompensationType.PROVIDER_STATUS_RECOVERY, 'PROVIDER_AMBIGUOUS', ctx.bookingId),
      ]);
    }

    return this.empty('NO_COMPENSATION', 'NO_ACTION_REQUIRED');
  }

  private action(
    type: CompensationType,
    reasonCode: string,
    targetReference: string,
    amountMinor?: number,
    currency?: string,
  ): CompensationAction {
    return {
      compensationType: type,
      reasonCode,
      targetReference,
      // Only the SAFE non-financial actions are auto-executable in P5.3A. Financial actions +
      // MANUAL_REVIEW + confirmed-booking cancellation are planned but never auto-executed.
      autoExecutable: SAFE_NON_FINANCIAL_ACTIONS.has(type),
      amountMinor,
      currency,
    };
  }

  private of(classification: string, actions: CompensationAction[]): CompensationPlan {
    const requiresManualReview = actions.some(
      (a) =>
        a.compensationType === CompensationType.MANUAL_REVIEW ||
        FINANCIAL_ACTIONS.has(a.compensationType),
    );
    const autoExecutable =
      actions.length > 0 && !requiresManualReview && actions.every((a) => a.autoExecutable);
    return {
      classification,
      actions,
      autoExecutable,
      requiresManualReview,
      reasonCode: actions[0]?.reasonCode ?? classification,
    };
  }

  private empty(classification: string, reasonCode: string): CompensationPlan {
    return {
      classification,
      actions: [],
      autoExecutable: false,
      requiresManualReview: false,
      reasonCode,
    };
  }
}
