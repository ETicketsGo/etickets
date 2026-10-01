import type { TransferReversalState } from '../provider/payment-provider.interface';

/**
 * Deciding what to do about a reversal attempt whose outcome we never learned.
 *
 * ── THE RULE EVERYTHING HERE OBEYS ─────────────────────────────────────────────────
 * Reconciliation may SUPPLY evidence that was missing. It may never OVERTURN evidence that is
 * already settled.
 *
 * Resolving an UNKNOWN attempt from a provider read is supplying: nothing was decided before, so
 * nothing is being contradicted. Flipping a COMPLETED attempt to FAILED because a later read
 * disagrees would be overturning, and it is the hardcoded-COMPLETED mistake wearing a different
 * hat - code deciding a financial fact it cannot see. Those become operator cases.
 *
 * Pure functions over values, so every branch is testable without a provider, a database or a
 * clock.
 */

/** An attempt as reconciliation needs to see it. */
export interface ReconcilableAttempt {
  id: string;
  status: 'REQUESTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  requestedMinor: number;
  confirmedMinor: number;
  /** Total confirmed by OTHER completed attempts on the same settlement. */
  otherConfirmedMinor: number;
}

export type ReconciliationAction =
  /** The provider's reading matches what we already hold. Nothing to do. */
  | { kind: 'AGREES' }
  /** Evidence we did not have: settle the attempt as completed for this amount. */
  | { kind: 'CONFIRM'; confirmedMinor: number; reason: string }
  /** Evidence we did not have: the provider never reversed anything for this attempt. */
  | { kind: 'MARK_FAILED'; reason: string }
  /** Still unresolved, and safe to ask again later. */
  | { kind: 'STILL_UNKNOWN'; reason: string }
  /**
   * Our record and the provider disagree about something already settled.
   *
   * Never repaired automatically. A person decides, because the alternative is code silently
   * rewriting a financial fact on the strength of one read.
   */
  | { kind: 'OPERATOR_REVIEW'; reason: string };

/**
 * What a provider read means for one attempt.
 *
 * `state.amountReversedMinor` is cumulative across the whole transfer, so the share attributable
 * to THIS attempt is whatever it covers beyond what other completed attempts already account
 * for. That subtraction is the only arithmetic here, and it is why `otherConfirmedMinor` is
 * passed in rather than guessed.
 */
export function reconcileAttempt(
  attempt: ReconcilableAttempt,
  state: TransferReversalState,
): ReconciliationAction {
  const unexplained = state.amountReversedMinor - attempt.otherConfirmedMinor;

  switch (attempt.status) {
    case 'COMPLETED': {
      /*
        Already settled. The only question is whether the provider still agrees, and a
        disagreement is never ours to resolve.
      */
      if (state.amountReversedMinor < attempt.otherConfirmedMinor + attempt.confirmedMinor) {
        return {
          kind: 'OPERATOR_REVIEW',
          reason:
            'we recorded this reversal as completed, and the provider reports less reversed than that',
        };
      }
      return { kind: 'AGREES' };
    }

    case 'FAILED': {
      /*
        We recorded an authoritative refusal. If the provider has since reversed more than our
        other attempts explain, something happened that we called a failure.
      */
      if (unexplained > 0) {
        return {
          kind: 'OPERATOR_REVIEW',
          reason: 'we recorded this reversal as failed, and the provider reports money reversed',
        };
      }
      return { kind: 'AGREES' };
    }

    case 'REQUESTED':
    case 'PROCESSING':
    case 'UNKNOWN': {
      // Nothing was decided, so a provider read can decide it.
      if (unexplained <= 0) {
        /*
          The provider reversed nothing beyond what other attempts explain. For a REQUESTED row
          that is still in flight this may simply be early, so it stays unresolved rather than
          being called a failure - but it is now a knowing decision rather than an absence.
        */
        return {
          kind: 'MARK_FAILED',
          reason: 'the provider reports nothing reversed for this attempt',
        };
      }
      if (unexplained >= attempt.requestedMinor) {
        return {
          kind: 'CONFIRM',
          confirmedMinor: attempt.requestedMinor,
          reason: 'the provider reports at least this attempt was reversed',
        };
      }
      /*
        The provider reversed SOME of what we asked for. Confirming the partial amount would be
        inventing a split we cannot attribute, and confirming the full amount would overstate.
      */
      return {
        kind: 'OPERATOR_REVIEW',
        reason: `the provider reports ${unexplained} reversed against a request of ${attempt.requestedMinor}`,
      };
    }
  }
}

/** Whether an attempt is old enough to be worth asking the provider about. */
export function isStale(
  status: ReconcilableAttempt['status'],
  requestedAt: Date,
  now: Date,
  windows: { requestedMs: number; processingMs: number },
): boolean {
  const age = now.getTime() - requestedAt.getTime();
  if (status === 'REQUESTED') return age >= windows.requestedMs;
  if (status === 'PROCESSING') return age >= windows.processingMs;
  // UNKNOWN is always worth asking about; it has no expected completion time.
  return status === 'UNKNOWN';
}

/**
 * Whether a reversal may be raised again for the same cause.
 *
 * ── WHY THIS IS NOT "IS IT OLD" ────────────────────────────────────────────────────
 * A stale REQUESTED attempt is NOT automatically retryable. The crash may have happened while
 * the provider call was in flight, so the provider may already have acted - and reissuing would
 * claw the money back twice.
 *
 * Only an attempt whose outcome is AUTHORITATIVELY known to be "nothing happened" may be
 * superseded. Everything else must be resolved by reading the provider first.
 */
export function maySupersede(status: ReconcilableAttempt['status']): boolean {
  return status === 'FAILED';
}
