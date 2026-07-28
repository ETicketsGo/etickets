/**
 * Refund financial reconciliation (ADR-043 §Phase 6, P5.3B). A deterministic, READ-ONLY
 * classifier that compares the LOCAL refund/payment state against the PROVIDER-reported refund
 * state and the money invariants, and emits a bounded classification + a recommended operator
 * action. It NEVER moves money and NEVER mutates state — a drift always resolves to human review
 * (or a bounded status re-query); automatic finalization only ever happens through the executor's
 * guarded exactly-once path, never here.
 *
 * Invariants checked: 0 <= refundedMinor <= capturedMinor; a completed full refund ⇒ payment
 * REFUNDED and refundedMinor == capturedMinor; currency never changes; at most one completed
 * refund per captured payment.
 */
export type RefundReconClassification =
  // ── consistent ──
  | 'CONSISTENT_NO_REFUND' // captured, nothing refunded, no refund records — expected steady state
  | 'CONSISTENT_FULL_REFUND' // payment REFUNDED, refundedMinor == captured, provider COMPLETED
  // ── in-flight (watch, not drift) ──
  | 'REFUND_IN_FLIGHT' // local PROCESSING intent; provider not yet definitive — keep watching
  | 'INTENT_WITHOUT_OUTCOME' // PROCESSING intent past the age threshold, no provider status → re-query
  // ── drift requiring manual review ──
  | 'LOCAL_REFUNDED_PROVIDER_MISSING' // local REFUNDED but provider reports no/failed refund
  | 'PROVIDER_REFUNDED_LOCAL_MISSING' // provider COMPLETED but local payment still SUCCEEDED
  | 'AMOUNT_MISMATCH' // provider-refunded amount != local refundedMinor
  | 'CURRENCY_MISMATCH' // provider refund currency != booking currency
  | 'PROVIDER_REFUND_FAILED' // provider FAILED while local intent still open
  | 'SETTLEMENT_UNKNOWN' // refund present but settlement state can't be confirmed
  | 'DUPLICATE_COMPLETED_REFUND' // more than one COMPLETED refund for one captured payment
  // ── invariant breach (critical) ──
  | 'OVER_REFUND' // refundedMinor > capturedMinor — must never happen
  | 'NEGATIVE_REFUND'; // refundedMinor < 0 — must never happen

export type RefundReconAction = 'NONE' | 'RETRY_STATUS_QUERY' | 'MANUAL_REVIEW';

export interface RefundReconInput {
  paymentStatus: string; // local PaymentStatus (SUCCEEDED | REFUNDED | ...)
  capturedMinor: number; // amountMinor captured
  refundedMinor: number; // local cumulative refundedMinor
  currency: string;
  /** Local Refund rows for this booking (status/amount/currency). */
  localRefunds: Array<{ status: string; amountMinor: number; currency?: string }>;
  /** Provider-reported refund, if a status query was performed. */
  providerRefund?: { status: string; amountMinor?: number; currency?: string } | null;
  /** Whether settlement for the underlying capture is confirmed knowable. */
  settlementConfirmed?: boolean;
  /** Age of the oldest open PROCESSING intent, seconds (for the re-query threshold). */
  openIntentAgeSeconds?: number;
  /** Threshold beyond which an outcome-less intent should be re-queried. Default 900s. */
  intentStaleAfterSeconds?: number;
}

export interface RefundReconResult {
  classification: RefundReconClassification;
  action: RefundReconAction;
  consistent: boolean;
  detail: string;
}

const review = (classification: RefundReconClassification, detail: string): RefundReconResult => ({
  classification,
  action: 'MANUAL_REVIEW',
  consistent: false,
  detail,
});

export function classifyRefundReconciliation(input: RefundReconInput): RefundReconResult {
  const {
    paymentStatus,
    capturedMinor,
    refundedMinor,
    currency,
    localRefunds,
    providerRefund,
    settlementConfirmed,
    openIntentAgeSeconds = 0,
    intentStaleAfterSeconds = 900,
  } = input;

  // ── invariant breaches first (critical) ──
  if (refundedMinor < 0) return review('NEGATIVE_REFUND', 'refundedMinor is negative');
  if (refundedMinor > capturedMinor) {
    return review(
      'OVER_REFUND',
      `refundedMinor ${refundedMinor} exceeds captured ${capturedMinor}`,
    );
  }

  const completed = localRefunds.filter((r) => r.status === 'COMPLETED');
  const processing = localRefunds.filter((r) => r.status === 'PROCESSING');
  const failed = localRefunds.filter((r) => r.status === 'FAILED');

  if (completed.length > 1) {
    return review(
      'DUPLICATE_COMPLETED_REFUND',
      `${completed.length} completed refunds for one capture`,
    );
  }

  // Currency invariant — a refund must be in the booking currency.
  const mismatchedCurrency = [...completed, ...processing].find(
    (r) => r.currency && r.currency !== currency,
  );
  if (mismatchedCurrency) {
    return review(
      'CURRENCY_MISMATCH',
      `refund currency ${mismatchedCurrency.currency} != ${currency}`,
    );
  }
  if (providerRefund?.currency && providerRefund.currency !== currency) {
    return review(
      'CURRENCY_MISMATCH',
      `provider refund currency ${providerRefund.currency} != ${currency}`,
    );
  }

  const providerCompleted = providerRefund?.status === 'COMPLETED';
  const providerFailed = providerRefund?.status === 'FAILED';

  // ── local REFUNDED reconciliation ──
  if (paymentStatus === 'REFUNDED') {
    if (providerRefund && (providerFailed || providerRefund.status === 'NOT_FOUND')) {
      return review(
        'LOCAL_REFUNDED_PROVIDER_MISSING',
        'payment REFUNDED locally but provider has no successful refund',
      );
    }
    if (
      providerCompleted &&
      providerRefund.amountMinor != null &&
      providerRefund.amountMinor !== refundedMinor
    ) {
      return review(
        'AMOUNT_MISMATCH',
        `provider refunded ${providerRefund.amountMinor} != local ${refundedMinor}`,
      );
    }
    if (settlementConfirmed === false) {
      return review('SETTLEMENT_UNKNOWN', 'refund recorded but settlement state is unconfirmed');
    }
    if (refundedMinor !== capturedMinor) {
      // A FULL refund must fully offset the capture.
      return review(
        'AMOUNT_MISMATCH',
        `full refund expected ${capturedMinor} but refundedMinor is ${refundedMinor}`,
      );
    }
    return {
      classification: 'CONSISTENT_FULL_REFUND',
      action: 'NONE',
      consistent: true,
      detail: 'full refund reconciled',
    };
  }

  // ── payment still SUCCEEDED (not yet locally refunded) ──
  if (providerCompleted) {
    return review(
      'PROVIDER_REFUNDED_LOCAL_MISSING',
      'provider reports a completed refund the local record has not finalized',
    );
  }
  if (providerFailed && processing.length > 0) {
    return review(
      'PROVIDER_REFUND_FAILED',
      'provider refund FAILED while a local intent is still open',
    );
  }
  if (processing.length > 0) {
    if (!providerRefund && openIntentAgeSeconds >= intentStaleAfterSeconds) {
      return {
        classification: 'INTENT_WITHOUT_OUTCOME',
        action: 'RETRY_STATUS_QUERY',
        consistent: false,
        detail: `open intent ${openIntentAgeSeconds}s without a provider outcome`,
      };
    }
    return {
      classification: 'REFUND_IN_FLIGHT',
      action: 'NONE',
      consistent: true,
      detail: 'refund intent in flight',
    };
  }
  if (failed.length > 0 && completed.length === 0) {
    return review('PROVIDER_REFUND_FAILED', 'local refund FAILED, no completed refund');
  }

  return {
    classification: 'CONSISTENT_NO_REFUND',
    action: 'NONE',
    consistent: true,
    detail: 'captured, no refund expected',
  };
}
