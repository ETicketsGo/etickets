/**
 * The rules a reversal attempt obeys, as arithmetic and transitions and nothing else.
 *
 * ── WHY THIS IS PURE ───────────────────────────────────────────────────────────────
 * No provider, no database, no clock. Every rule below is a function of values already in hand,
 * so the dangerous cases - a timeout, a provider contradicting itself, a partial reversal that
 * must not look like a full one - are exhaustively testable without a sandbox and without
 * waiting for the lifecycle to be wired up.
 *
 * Nothing here is called in production yet. PR 4 connects it.
 */

/** Mirrors `SettlementReversalStatus` in schema.prisma. */
export type SettlementReversalStatus =
  'REQUESTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';

/**
 * Where a reversal attempt may go next.
 *
 * ── UNKNOWN IS NOT TERMINAL, AND THAT IS THE POINT ─────────────────────────────────
 * A timeout is not a failure. The provider may have moved money while our response was lost, so
 * recording it as either COMPLETED or FAILED manufactures certainty nobody has. `UNKNOWN` is the
 * honest answer, and it keeps its exits open because it is a work item for reconciliation rather
 * than a resting place.
 *
 * ── TERMINAL MEANS TERMINAL ────────────────────────────────────────────────────────
 * COMPLETED and FAILED lead nowhere. A provider later contradicting one of them is NOT a
 * transition - it is a mismatch for a person to look at. Letting code flip a settled financial
 * fact would be the hardcoded-COMPLETED mistake wearing a different hat.
 */
export const REVERSAL_TRANSITIONS: Record<SettlementReversalStatus, SettlementReversalStatus[]> = {
  REQUESTED: ['PROCESSING', 'COMPLETED', 'FAILED', 'UNKNOWN'],
  PROCESSING: ['COMPLETED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export function canTransitionReversal(
  from: SettlementReversalStatus,
  to: SettlementReversalStatus,
): boolean {
  return REVERSAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A state no evidence can move out of. A contradiction becomes a mismatch, not a transition. */
export function isTerminalReversal(status: SettlementReversalStatus): boolean {
  return REVERSAL_TRANSITIONS[status].length === 0;
}

/**
 * Whether an attempt in this state may be retried by raising a NEW attempt.
 *
 * Retry never mutates the attempt that failed: the old row keeps its evidence and the new one
 * points at it. So "can this be retried" is a question about raising a successor, never about
 * reopening a closed argument with the provider.
 */
export function canSupersede(status: SettlementReversalStatus): boolean {
  // A COMPLETED reversal has nothing left to retry. The rest are either unfinished or refused.
  return status !== 'COMPLETED';
}

/** The shape the amount rules need. Deliberately not the Prisma row. */
export interface ReversalAmountView {
  status: SettlementReversalStatus;
  requestedMinor: number;
  confirmedMinor: number;
}

/**
 * Money this attempt has actually moved.
 *
 * Only COMPLETED counts. This is the single rule that makes an optimistic decrement impossible
 * to express: a PROCESSING or UNKNOWN attempt contributes nothing, however much it asked for.
 */
export function movedMinor(attempt: ReversalAmountView): number {
  return attempt.status === 'COMPLETED' ? attempt.confirmedMinor : 0;
}

/** Total confirmed across a settlement's attempts. */
export function confirmedTotalMinor(attempts: readonly ReversalAmountView[]): number {
  return attempts.reduce((total, a) => total + movedMinor(a), 0);
}

/**
 * What the organizer still holds from this settlement.
 *
 * `releasedMinor − Σ confirmed`. Derived rather than tracked, which is what makes it checkable:
 * a stored number that drifts has nothing to be compared against.
 */
export function outstandingTransferredMinor(
  releasedMinor: number,
  attempts: readonly ReversalAmountView[],
): number {
  return releasedMinor - confirmedTotalMinor(attempts);
}

/**
 * Whether an attempt is internally consistent.
 *
 * Returns the reasons it is not, so a caller can report them rather than a bare false.
 */
export function reversalViolations(attempt: ReversalAmountView): string[] {
  const out: string[] = [];
  if (attempt.requestedMinor <= 0) out.push('requestedMinor must be positive');
  if (attempt.confirmedMinor < 0) out.push('confirmedMinor cannot be negative');
  if (attempt.status !== 'COMPLETED' && attempt.confirmedMinor !== 0) {
    // The invariant that closes the optimistic decrement: only COMPLETED may carry money.
    out.push(`confirmedMinor must be 0 while ${attempt.status}`);
  }
  if (attempt.confirmedMinor > attempt.requestedMinor) {
    out.push('confirmedMinor cannot exceed requestedMinor');
  }
  return out;
}

/*
  REMOVED: `DerivedSettlementPosition` and `derivedPosition()`.

  They computed a settlement's financial position - TRANSFERRED / PARTIALLY_REFUNDED / REVERSED -
  from `releasedMinor` and confirmed reversals, and nothing in the API ever called them.

  Wiring a caller would have created drift rather than closing a gap. Position is already said by
  the money: `releasedMinor` is what went out, `transferredMinor` is what is still out, and their
  difference is what came back. A stored position would be a second copy of that, and a second
  copy can disagree with the first.

  It would also have changed no behaviour. Both readers of settlement status - the payout
  boundary's `SETTLEMENT_CLAIMED_STATUSES` and the Finance producer's `RELEASED_STATUSES` -
  already contain all four statuses, so moving a row from TRANSFERRED to REVERSED is invisible to
  both.

  Every position a settlement can hold is asserted against the money in
  apps/api/src/finance/settlement-position.spec.ts.
*/

/**
 * How much of `wanted` may still be reversed.
 *
 * Clamped at the outstanding amount, so an attempt can never ask for more than the organizer
 * still holds - invariant I1, enforced where the number is produced rather than checked after.
 */
export function reversibleMinor(
  wanted: number,
  releasedMinor: number,
  attempts: readonly ReversalAmountView[],
): number {
  const outstanding = outstandingTransferredMinor(releasedMinor, attempts);
  return Math.max(0, Math.min(wanted, outstanding));
}
