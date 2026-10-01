/**
 * One reconciliation engine, fed by normalized provider evidence.
 *
 * ── THE DEFECT THIS REPLACES (R4) ──────────────────────────────────────────────────
 * There were two implementations of reversal accounting. The orchestration path wrote attempts
 * and decremented money from confirmed amounts; the webhook path called `onTransferReversed`
 * with nothing but a transfer id, set the settlement to REVERSED, and never touched the money at
 * all - throwing away the cumulative amount the webhook payload was carrying. The same provider
 * money movement was therefore described two different ways depending on which path saw it.
 *
 * The fix is not another guard. Every path - synchronous response, webhook, provider lookup -
 * now normalizes to the SAME evidence shape and runs through the SAME function, so there is only
 * one place where provider facts become internal money facts.
 *
 * ── WHY THE PROVIDER'S NUMBER IS CUMULATIVE ────────────────────────────────────────
 * Verified in the installed SDK types, not assumed:
 *
 *   Stripe    Transfer.amount_reversed - "Amount in cents (or local equivalent) reversed (can be
 *             less than the amount attribute on the transfer if a partial reversal was issued)"
 *   Razorpay  Transfer.amount_reversed - "Amount reversed from this transfer for refunds"
 *
 * Both accumulate across every reversal on that transfer. So the provider's figure is NEVER
 * added to ours - it is compared with it, and the difference is what is newly proven. A provider
 * reporting 300 against 200 already confirmed internally means 100 is new, not 300.
 */

/** Where a piece of provider evidence came from. Audit only: it must not change the arithmetic. */
export type EvidenceSource = 'SYNC_RESPONSE' | 'WEBHOOK' | 'PROVIDER_QUERY';

/**
 * Authoritative provider state about one transfer, normalized.
 *
 * Adapters translate Stripe and Razorpay payloads into this. The financial domain sees only
 * this shape, never a raw provider object - which is what stops provider-specific quirks
 * (Razorpay types `amount` as `number | string`) reaching the arithmetic.
 */
export interface TransferEvidence {
  provider: string;
  providerTransferId: string;
  /** As the provider spells it. Compared case-insensitively; never rewritten. */
  currency: string;
  /** The transfer's original amount, when the provider states it authoritatively. */
  originalTransferredMinor: number | null;
  /** Total reversed across every reversal on this transfer, as the provider reports it now. */
  cumulativeReversedMinor: number;
  /** The provider's own lifecycle word, unmapped. */
  providerStatusRaw: string | null;
  observedAt: Date;
  source: EvidenceSource;
}

/** What we already believe about the settlement this evidence is about. */
export interface SettlementReversalFacts {
  settlementId: string;
  providerTransferId: string | null;
  /** As stored. Settlement rows hold lower case; evidence may not. */
  currency: string;
  /** Total ever transferred OUT to the organizer. Never decremented. */
  releasedMinor: number;
  /** Sum of `confirmedMinor` across COMPLETED attempts. What has authoritatively come back. */
  confirmedReversedMinor: number;
  /** Attempts that could still change the answer, so a conclusion may be premature. */
  unresolvedAttempts: number;
}

export type ReconciliationOutcome =
  /** The provider agrees with what we already hold. Idempotent re-observation lands here. */
  | { kind: 'AGREES'; cumulativeReversedMinor: number }
  /** The provider proves money came back that we had not confirmed. */
  | { kind: 'NEWLY_CONFIRMED'; deltaMinor: number; cumulativeReversedMinor: number }
  /**
   * Evidence older than what we already hold. Not a contradiction - just stale.
   *
   * Dropped rather than applied, because confirmed money must never decrease on the strength of
   * a late delivery of an earlier state.
   */
  | { kind: 'STALE'; reportedMinor: number; alreadyConfirmedMinor: number }
  /** The provider and our ledger cannot both be right. Never resolved by code. */
  | { kind: 'MISMATCH'; reason: string; detail: Record<string, unknown> };

const sameCurrency = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * What one piece of provider evidence proves about one settlement.
 *
 * Pure: no database, no provider, no clock. Every guard below is a case where applying the
 * evidence would corrupt the ledger, and each returns MISMATCH rather than clamping - a figure
 * bent to make the totals fit is a figure nobody can audit.
 */
export function reconcileTransferEvidence(
  facts: SettlementReversalFacts,
  evidence: TransferEvidence,
): ReconciliationOutcome {
  // ── the evidence must be ABOUT this settlement ────────────────────────────────
  if (
    facts.providerTransferId == null ||
    facts.providerTransferId !== evidence.providerTransferId
  ) {
    return {
      kind: 'MISMATCH',
      reason: 'evidence is for a different transfer',
      detail: { ours: facts.providerTransferId, theirs: evidence.providerTransferId },
    };
  }
  if (!sameCurrency(facts.currency, evidence.currency)) {
    /*
      Settlement rows store lower case and providers vary, so this folds case - but a genuinely
      different currency is never reconciled. Money in the wrong denomination is not a rounding
      problem.
    */
    return {
      kind: 'MISMATCH',
      reason: 'currency does not match',
      detail: { ours: facts.currency, theirs: evidence.currency },
    };
  }

  // ── the numbers must be possible ──────────────────────────────────────────────
  if (!Number.isInteger(evidence.cumulativeReversedMinor) || evidence.cumulativeReversedMinor < 0) {
    return {
      kind: 'MISMATCH',
      reason: 'provider reported an impossible reversed amount',
      detail: { cumulativeReversedMinor: evidence.cumulativeReversedMinor },
    };
  }
  if (evidence.cumulativeReversedMinor > facts.releasedMinor) {
    /*
      The provider says more came back than we ever sent. One of the two is wrong about the
      original transfer, and silently accepting it would drive the outstanding amount negative.
    */
    return {
      kind: 'MISMATCH',
      reason: 'provider reports more reversed than was ever released',
      detail: {
        cumulativeReversedMinor: evidence.cumulativeReversedMinor,
        releasedMinor: facts.releasedMinor,
      },
    };
  }
  if (
    evidence.originalTransferredMinor != null &&
    evidence.originalTransferredMinor !== facts.releasedMinor
  ) {
    return {
      kind: 'MISMATCH',
      reason: 'provider and ledger disagree on the original transfer amount',
      detail: {
        ours: facts.releasedMinor,
        theirs: evidence.originalTransferredMinor,
      },
    };
  }

  // ── compare, never add ────────────────────────────────────────────────────────
  const delta = evidence.cumulativeReversedMinor - facts.confirmedReversedMinor;

  if (delta === 0)
    return { kind: 'AGREES', cumulativeReversedMinor: evidence.cumulativeReversedMinor };

  if (delta < 0) {
    /*
      Two very different situations share this shape, and they are told apart by whether
      anything is still in flight.

      With unresolved attempts, a late webhook carrying an earlier cumulative figure is ordinary
      out-of-order delivery: stale, dropped, harmless. With nothing in flight, the provider is
      asserting that LESS has come back than we have already recorded as confirmed - a
      contradiction about settled money, and never ours to resolve.
    */
    if (facts.unresolvedAttempts > 0) {
      return {
        kind: 'STALE',
        reportedMinor: evidence.cumulativeReversedMinor,
        alreadyConfirmedMinor: facts.confirmedReversedMinor,
      };
    }
    return {
      kind: 'MISMATCH',
      reason: 'provider reports less reversed than we have already confirmed',
      detail: {
        cumulativeReversedMinor: evidence.cumulativeReversedMinor,
        confirmedReversedMinor: facts.confirmedReversedMinor,
      },
    };
  }

  return {
    kind: 'NEWLY_CONFIRMED',
    deltaMinor: delta,
    cumulativeReversedMinor: evidence.cumulativeReversedMinor,
  };
}

/**
 * What the organizer still holds, derived.
 *
 * The four questions this model has to answer, and where each is read from:
 *
 *   1. How much originally reached the organizer?      `releasedMinor`
 *   2. How much has the provider authoritatively       `confirmedReversedMinor`
 *      recovered?                                      (Σ confirmedMinor over COMPLETED attempts)
 *   3. How much remains economically outstanding?      this function
 *   4. What refund liability has been recorded?        `Settlement.refundsMinor` - an ACCOUNTING
 *                                                      fact, and deliberately not money movement
 */
export function outstandingMinor(facts: SettlementReversalFacts): number {
  return facts.releasedMinor - facts.confirmedReversedMinor;
}
