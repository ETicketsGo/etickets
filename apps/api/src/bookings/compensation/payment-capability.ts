import { CompensationType } from './compensation-types';

/**
 * Decide the correct PAYMENT compensation action from ACTUAL provider capabilities + payment
 * state (ADR-043 §19). A captured payment is never labelled voidable when the provider only
 * refunds; void is chosen only for an authorized-not-captured payment on an auth/capture
 * provider. When the captured/authorized state is unknown, the decision is MANUAL_REVIEW —
 * never a guess that could move money incorrectly.
 */
export interface PaymentState {
  /** true = funds captured; false = authorized only; undefined = unknown. */
  captured?: boolean;
}
export interface PaymentCapabilityView {
  supportsAuthorizeCapture: boolean;
  /** The provider contract always supports refund; kept explicit for clarity. */
  supportsRefund: boolean;
}

export function choosePaymentCompensation(
  payment: PaymentState,
  cap: PaymentCapabilityView,
): CompensationType {
  if (payment.captured === undefined) return CompensationType.MANUAL_REVIEW;
  if (payment.captured === false) {
    // Authorized-not-captured: void it if the provider distinguishes auth/capture; else refund.
    return cap.supportsAuthorizeCapture
      ? CompensationType.PAYMENT_VOID
      : CompensationType.PAYMENT_REFUND;
  }
  // Captured: only a refund can return the money.
  return cap.supportsRefund ? CompensationType.PAYMENT_REFUND : CompensationType.MANUAL_REVIEW;
}
