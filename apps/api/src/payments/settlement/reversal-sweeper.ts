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
  /** How many unproductive looks so far. The position on the backoff ladder. */
  reconcileCount: number;
}

/**
 * How long to leave an attempt alone before asking about it.
 *
 * These are judgements about provider latency, not facts, so they are stated in one place where
 * they can be argued with rather than scattered through the query.
 */
export interface SweepWindows {
  /**
   * UNKNOWN is the shortest wait, and deliberately so.
   *
   * It is the only state where nothing is coming unless we ask, so every minute spent waiting is
   * a minute money is unaccounted for. The other two have a provider working on them.
   */
  unknownMs: number;
  /**
   * A REQUESTED attempt has not had its response recorded. Usually that means it is simply in
   * flight; past this it means something interrupted it.
   */
  requestedMs: number;
  /** The provider acknowledged it, so it is given longer before being chased. */
  processingMs: number;
}

export const DEFAULT_SWEEP_WINDOWS: SweepWindows = {
  unknownMs: 5 * 60_000,
  requestedMs: 10 * 60_000,
  processingMs: 15 * 60_000,
};

/**
 * How long to wait after each unproductive look.
 *
 * ── WHY A LADDER AND NOT A FIXED INTERVAL ──────────────────────────────────────────
 * A fixed interval has to be either short - which turns a provider outage into thousands of
 * pointless calls, and may well be what gets us rate limited at the worst moment - or long,
 * which leaves a genuinely stuck attempt unexamined for hours. The ladder is short where an
 * answer is still plausibly arriving and long once it clearly is not.
 *
 * It CAPS rather than growing without bound: an attempt nobody can resolve is checked every four
 * hours forever, because it is money in an unknown state and giving up on it is not an option.
 * Nothing here retries a money movement - see the one rule at the top of this file.
 */
export const BACKOFF_LADDER_MS: readonly number[] = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
];

/**
 * The wait before the next look, given how many have already happened.
 *
 * Clamped at both ends. A negative or non-integer count is a data fault rather than a reason to
 * ask the provider immediately, so it reads as the first rung.
 */
export function backoffFor(reconcileCount: number): number {
  if (!Number.isFinite(reconcileCount) || reconcileCount < 1) return BACKOFF_LADDER_MS[0];
  const index = Math.min(Math.floor(reconcileCount), BACKOFF_LADDER_MS.length) - 1;
  return BACKOFF_LADDER_MS[index];
}

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

  /*
    Already looked once: the ladder decides, not the status. A long-stuck attempt is not more
    urgent for having been stuck longer - it is less likely to resolve on its own, which is the
    opposite.
  */
  if (candidate.lastReconciledAt != null) {
    const since = now.getTime() - candidate.lastReconciledAt.getTime();
    return since >= backoffFor(candidate.reconcileCount);
  }

  // Never looked: wait for the state's own window before the first question.
  const age = now.getTime() - candidate.requestedAt.getTime();
  if (candidate.status === 'REQUESTED') return age >= windows.requestedMs;
  if (candidate.status === 'PROCESSING') return age >= windows.processingMs;
  return age >= windows.unknownMs;
}

/** What one sweep is allowed to do, so a backlog cannot become an unbounded run. */
export interface SweepLimits {
  /** Most attempts observed in one sweep. The rest wait for the next one. */
  batchSize: number;
  /** Most provider calls in flight at once. */
  concurrency: number;
}

export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  batchSize: 50,
  concurrency: 4,
};

/**
 * The attempts this sweep will actually ask about, oldest-looked first.
 *
 * ── WHY THE ORDER MATTERS ──────────────────────────────────────────────────────────
 * With a backlog larger than one batch, an arbitrary order can starve a row forever: the same
 * fifty get picked every time and the fifty-first is never reached. Least-recently-looked first
 * is the order that cannot starve, because looking at a row moves it to the back.
 *
 * An attempt never looked at sorts before every attempt that has been, so a new UNKNOWN is not
 * stuck behind a backlog of old ones.
 */
export function planSweep(
  candidates: readonly SweepCandidate[],
  now: Date,
  windows: SweepWindows = DEFAULT_SWEEP_WINDOWS,
  limits: SweepLimits = DEFAULT_SWEEP_LIMITS,
): SweepCandidate[] {
  const due = candidates.filter((c) => isSweepDue(c, now, windows));
  const sorted = [...due].sort((a, b) => {
    const at = a.lastReconciledAt?.getTime() ?? -1;
    const bt = b.lastReconciledAt?.getTime() ?? -1;
    if (at !== bt) return at - bt;
    // Stable within a tie, so a sweep is reproducible from the same input.
    return a.id < b.id ? -1 : 1;
  });
  const size = Number.isFinite(limits.batchSize) && limits.batchSize > 0 ? limits.batchSize : 0;
  return sorted.slice(0, size);
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

/**
 * When an unresolved ambiguity should also be put in front of a person.
 *
 * ── WHY THIS IS NOT A STATUS ───────────────────────────────────────────────────────
 * Two different questions get conflated constantly, and conflating them corrupts money:
 *
 *   FINANCIALLY, what do we know?        -> UNKNOWN. Still UNKNOWN. Age proves nothing.
 *   OPERATIONALLY, who should look?      -> somebody, once it has been unresolved long enough.
 *
 * An attempt that has been UNKNOWN for a month is not FAILED, and marking it FAILED because
 * nobody resolved it would be inventing a money fact out of impatience. So escalation is
 * DERIVED from fields that already exist and is deliberately not persisted as a state: there is
 * nothing to migrate, nothing that can drift from the financial record, and no column somebody
 * can later mistake for an outcome.
 *
 * Escalating also does NOT stop reconciliation. The sweeper keeps asking at the capped cadence,
 * because the answer is still worth having and a person looking does not make the provider's
 * record any less authoritative.
 */
export interface EscalationPolicy {
  /**
   * Unresolved for this long and a person should look, whatever the ladder says.
   *
   * Conservative on purpose. It is an operational trigger, not a financial deadline, so being
   * early costs somebody a glance and being late costs money nobody is watching.
   */
  afterMs: number;
}

export const DEFAULT_ESCALATION: EscalationPolicy = {
  afterMs: 24 * 60 * 60_000,
};

/**
 * Why a person should look. Operational only - none of these is a money fact.
 */
export type AttentionReason =
  /** Unresolved longer than the policy allows. */
  | 'UNRESOLVED_TOO_LONG'
  /**
   * Every rung of the backoff ladder has been tried and the provider still has not given a
   * terminal answer. Distinct from the age trigger: an attempt can exhaust the ladder well
   * inside the age window if it was created during an outage, and it can pass the age window
   * having been asked only once if the worker was down.
   */
  | 'BACKOFF_LADDER_EXHAUSTED';

/**
 * Whether a person should also be looking at this attempt, and why.
 *
 * Empty means no operator attention is needed. It says nothing about whether the attempt is due
 * for another look - that is `isSweepDue`, and the two are intentionally independent.
 */
export function operatorAttention(
  candidate: SweepCandidate,
  now: Date,
  policy: EscalationPolicy = DEFAULT_ESCALATION,
): AttentionReason[] {
  const reasons: AttentionReason[] = [];

  const unresolvedMs = now.getTime() - candidate.requestedAt.getTime();
  if (Number.isFinite(policy.afterMs) && policy.afterMs > 0 && unresolvedMs >= policy.afterMs) {
    reasons.push('UNRESOLVED_TOO_LONG');
  }
  if (candidate.reconcileCount >= BACKOFF_LADDER_MS.length) {
    reasons.push('BACKOFF_LADDER_EXHAUSTED');
  }
  return reasons;
}

/**
 * What a sweep did, in the shape the existing reconciliation services report.
 *
 * `needsOperatorAttention` is counted and listed separately from anything financial, so a
 * report cannot be read as a change to the money.
 */
export interface SweepReport {
  scanned: number;
  /** Attempts the plan selected for a provider call. */
  observed: number;
  reconciled: number;
  providerUnreachable: number;
  notDue: number;
  noReference: number;
  /** Attempt ids a person should look at, with the reason. Never a status change. */
  needsOperatorAttention: Array<{ attemptId: string; reasons: AttentionReason[] }>;
}
