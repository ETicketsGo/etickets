import type { TransferEvidence } from './transfer-evidence';
import type { TransferReversalState } from '../provider/payment-provider.interface';

/**
 * Finding reversal attempts whose outcome we never learned, and asking the provider about them.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────────────
 * Provider OBSERVATION may be automated. Provider MONEY MOVEMENT may not.
 *
 *   UNKNOWN → QUERY → authoritative evidence → reconcile
 *
 * never
 *
 *   UNKNOWN → retry the money movement
 *
 * ── HOW THAT IS ENFORCED ───────────────────────────────────────────────────────────
 * Not by a rule somebody has to remember. The sweeper is handed a `ProviderReconciliationReader`
 * - an interface with exactly one method, which reads. It never receives an adapter that can
 * create a transfer, issue a reversal, or refund anything, so the capability is absent rather
 * than merely unused. A test can show a thing was not done; a narrower type means it could not be.
 */

/**
 * The only provider capability a reconciliation worker is given.
 *
 * Deliberately NOT the payment provider interface. That one can move money.
 */
export interface ProviderReconciliationReader {
  getTransferReversalState(transferId: string): Promise<TransferReversalState>;
}

/** An attempt as the sweeper selects it. */
export interface SweepCandidate {
  id: string;
  settlementId: string;
  provider: string;
  providerTransferId: string | null;
  currency: string;
  status: 'REQUESTED' | 'PROCESSING' | 'UNKNOWN';
  requestedAt: Date;
  lastReconciledAt: Date | null;
}

/**
 * How long to leave an attempt alone before asking about it.
 *
 * These are judgements about provider latency, not facts, so they are stated in one place where
 * they can be argued with rather than scattered through the query.
 */
export interface SweepWindows {
  /**
   * A REQUESTED attempt has not had its response recorded. Usually that means it is simply in
   * flight; past this it means something interrupted it.
   */
  requestedMs: number;
  /** The provider acknowledged it, so it is given longer before being chased. */
  processingMs: number;
  /** How long after an unproductive look before asking the same question again. */
  recheckMs: number;
}

export const DEFAULT_SWEEP_WINDOWS: SweepWindows = {
  requestedMs: 5 * 60_000,
  processingMs: 30 * 60_000,
  recheckMs: 60 * 60_000,
};

/**
 * Whether this attempt is worth a provider call right now.
 *
 * Two separate questions, and conflating them produces either a hammering poller or a stuck row:
 * is it old enough to be interesting, and has it been long enough since we last looked.
 */
export function isSweepDue(
  candidate: SweepCandidate,
  now: Date,
  windows: SweepWindows = DEFAULT_SWEEP_WINDOWS,
): boolean {
  if (candidate.providerTransferId == null) return false; // nothing to ask about

  if (candidate.lastReconciledAt != null) {
    if (now.getTime() - candidate.lastReconciledAt.getTime() < windows.recheckMs) return false;
  }

  const age = now.getTime() - candidate.requestedAt.getTime();
  if (candidate.status === 'REQUESTED') return age >= windows.requestedMs;
  if (candidate.status === 'PROCESSING') return age >= windows.processingMs;
  /*
    UNKNOWN has no expected completion time - nothing is coming unless we ask - so it is due as
    soon as the recheck window allows. It is also the only state where NOT asking leaves money
    unaccounted for indefinitely.
  */
  return true;
}

/** What the sweeper did about one candidate. Reported, never inferred from side effects. */
export type SweepResult =
  | { kind: 'RECONCILED'; attemptId: string; evidence: TransferEvidence }
  | { kind: 'NOT_DUE'; attemptId: string }
  | { kind: 'NO_REFERENCE'; attemptId: string }
  /**
   * The provider could not be asked.
   *
   * The attempt is left exactly as it was. An unreachable provider is not evidence of anything,
   * and turning "we could not ask" into "nothing happened" is how an ambiguous outcome becomes a
   * false conclusion.
   */
  | { kind: 'PROVIDER_UNREACHABLE'; attemptId: string; error: string };

/**
 * Ask the provider what it did about one attempt.
 *
 * Returns the evidence rather than applying it: the caller runs it through the same
 * reconciliation engine every other path uses, so the sweeper has no accounting of its own.
 */
export async function observeCandidate(
  candidate: SweepCandidate,
  reader: ProviderReconciliationReader,
  now: Date,
  windows: SweepWindows = DEFAULT_SWEEP_WINDOWS,
): Promise<SweepResult> {
  if (candidate.providerTransferId == null) {
    return { kind: 'NO_REFERENCE', attemptId: candidate.id };
  }
  if (!isSweepDue(candidate, now, windows)) {
    return { kind: 'NOT_DUE', attemptId: candidate.id };
  }

  try {
    const state = await reader.getTransferReversalState(candidate.providerTransferId);
    return {
      kind: 'RECONCILED',
      attemptId: candidate.id,
      evidence: {
        provider: candidate.provider,
        providerTransferId: state.transferId,
        currency: candidate.currency,
        originalTransferredMinor: null,
        cumulativeReversedMinor: state.amountReversedMinor,
        providerStatusRaw: state.providerStatusRaw,
        observedAt: now,
        source: 'PROVIDER_QUERY',
      },
    };
  } catch (err) {
    return {
      kind: 'PROVIDER_UNREACHABLE',
      attemptId: candidate.id,
      error: err instanceof Error ? err.message.slice(0, 200) : 'provider query failed',
    };
  }
}
