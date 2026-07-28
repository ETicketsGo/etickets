/**
 * Booking compensation domain vocabulary (ADR-043, P5.3A). Mirrors the Prisma
 * `CompensationType` / `CompensationState` enums. A compensation is ONE recovery action for
 * one booking; the planner produces them, a gated worker executes only the SAFE non-financial
 * ones in P5.3A. Money-moving actions (void/refund) and confirmed-booking cancellation are
 * planned but never auto-executed in this increment.
 */
export const CompensationType = {
  PAYMENT_VOID: 'PAYMENT_VOID',
  PAYMENT_REFUND: 'PAYMENT_REFUND',
  PROVIDER_RESERVATION_CANCEL: 'PROVIDER_RESERVATION_CANCEL',
  PROVIDER_BOOKING_CANCEL: 'PROVIDER_BOOKING_CANCEL',
  LOCAL_HOLD_RELEASE: 'LOCAL_HOLD_RELEASE',
  REDIS_LOCK_RELEASE: 'REDIS_LOCK_RELEASE',
  LOCAL_CONFIRMATION_RETRY: 'LOCAL_CONFIRMATION_RETRY',
  PROVIDER_STATUS_RECOVERY: 'PROVIDER_STATUS_RECOVERY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;
export type CompensationType = (typeof CompensationType)[keyof typeof CompensationType];

/** Actions that never move money and never cancel a confirmed provider booking. */
export const SAFE_NON_FINANCIAL_ACTIONS: ReadonlySet<CompensationType> = new Set([
  CompensationType.REDIS_LOCK_RELEASE,
  CompensationType.LOCAL_HOLD_RELEASE,
  CompensationType.PROVIDER_STATUS_RECOVERY,
  CompensationType.LOCAL_CONFIRMATION_RETRY,
]);

/** Actions that move money — never auto-executed in P5.3A. */
export const FINANCIAL_ACTIONS: ReadonlySet<CompensationType> = new Set([
  CompensationType.PAYMENT_VOID,
  CompensationType.PAYMENT_REFUND,
]);

export interface CompensationAction {
  compensationType: CompensationType;
  reasonCode: string;
  /** The concrete target (payment ref / reservation id / lock id / booking id). */
  targetReference: string;
  /** Whether this specific action is eligible for safe auto-execution in P5.3A. */
  autoExecutable: boolean;
  amountMinor?: number;
  currency?: string;
}

export interface CompensationPlan {
  classification: string;
  actions: CompensationAction[];
  autoExecutable: boolean;
  requiresManualReview: boolean;
  reasonCode: string;
}
