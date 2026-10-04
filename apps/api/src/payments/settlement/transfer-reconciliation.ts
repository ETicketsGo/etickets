import type { TransferLookup, TransferState } from '../provider/payment-provider.interface';

/**
 * Deciding what a provider's answer about a transfer means, as a pure function.
 *
 * ── OBSERVE, CLASSIFY, RECORD. NEVER REPAIR ────────────────────────────────────────────
 * Nothing here moves money, and nothing here can. It takes what we believe and what the
 * provider said and returns a classification; persisting that classification is the caller's
 * job, and ACTING on it is nobody's job yet.
 *
 * Detection and repair are separate privileges. A reconciliation worker that could also correct
 * what it found would be able to make a disagreement disappear by rewriting one side of it,
 * which is the failure this whole model exists to prevent.
 *
 * ── THE SHAPE OF THE HARD CASE ─────────────────────────────────────────────────────────
 * The attempts worth reconciling are the ones whose outcome we never learned - and those are
 * exactly the ones with no `providerTransferId`, because the provider never answered. So the
 * usual recovery of "look up transfer tr_abc" is unavailable precisely when it is needed, and
 * the only identifiers left are the ones WE chose. Whether a provider can be searched by any of
 * them is provider-specific; where it cannot, the honest outcome is `CANNOT_BE_ASKED` and the
 * resolution is a person.
 */

/** A capability-narrowed view of a provider: it can be asked, and it can do nothing else. */
export interface ProviderTransferReader {
  getTransferState(lookup: TransferLookup): Promise<TransferState>;
}

/** What we believe, as the attempt row records it. */
export interface LocalTransferFacts {
  attemptId: string;
  settlementId: string;
  organizationId: string;
  status: 'REQUESTED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  requestedMinor: number;
  currency: string;
  providerTransferId: string | null;
  idempotencyKey: string;
  destinationAccountId: string | null;
}

export type FindingKind =
  | 'AMOUNT_DISAGREES'
  | 'CURRENCY_DISAGREES'
  | 'PROVIDER_CONTRADICTS_LOCAL'
  | 'PROVIDER_HAS_NO_RECORD'
  | 'STILL_UNRESOLVED'
  | 'CANNOT_BE_ASKED';

/**
 * What one reconciliation pass concluded.
 *
 * `AGREES` and `RESOLVED` are the only outcomes that close anything, and even `RESOLVED` only
 * says the provider gave a conclusion - applying it to the money is a separate, explicit step
 * that no worker performs.
 */
export type TransferReconciliationOutcome =
  /** Nothing to reconcile: the attempt is not in doubt. */
  | { kind: 'AGREES'; reason: string }
  /** The provider gave a conclusion that matches what we asked for. */
  | { kind: 'RESOLVED'; disposition: 'SENT' | 'FAILED'; state: TransferState; reason: string }
  /** Something disagreed, or could not be established. A finding must be recorded. */
  | { kind: 'FINDING'; finding: FindingKind; state: TransferState | null; detail: string };

/** Attempt states worth asking about. The others are settled. */
export function isReconcilable(status: LocalTransferFacts['status']): boolean {
  return status === 'UNKNOWN' || status === 'REQUESTED';
}

/** The identifiers we can offer a provider for this attempt. */
export function lookupFor(local: LocalTransferFacts): TransferLookup {
  return {
    transferId: local.providerTransferId,
    idempotencyKey: local.idempotencyKey,
    amountMinor: local.requestedMinor,
    currency: local.currency,
    destinationAccountId: local.destinationAccountId,
  };
}

/**
 * Compare what we believe against what the provider said.
 *
 * Deliberately total over `TransferState['disposition']`, so a new provider disposition cannot
 * be added without a decision being made about what it proves.
 */
export function classifyTransferEvidence(
  local: LocalTransferFacts,
  state: TransferState,
): TransferReconciliationOutcome {
  switch (state.disposition) {
    case 'SENT': {
      /*
        The provider says it sent money. Before calling that a resolution, it has to be the
        money we asked for: an amount or currency that does not match is a worse problem than
        not knowing, because both sides think they are right.
      */
      if (
        state.currency !== null &&
        state.currency.toLowerCase() !== local.currency.toLowerCase()
      ) {
        return {
          kind: 'FINDING',
          finding: 'CURRENCY_DISAGREES',
          state,
          detail: `We asked in ${local.currency.toUpperCase()}; the provider reports ${state.currency.toUpperCase()}.`,
        };
      }
      if (state.amountMinor !== null && state.amountMinor !== local.requestedMinor) {
        return {
          kind: 'FINDING',
          finding: 'AMOUNT_DISAGREES',
          state,
          detail: `We asked for ${local.requestedMinor}; the provider reports ${state.amountMinor}.`,
        };
      }
      /*
        Both sides say the same thing. That is agreement, not a resolution - nothing was in
        doubt, and calling it RESOLVED would imply a question had been answered.
      */
      if (local.status === 'SUCCEEDED') {
        return { kind: 'AGREES', reason: 'We and the provider both say this transfer was sent.' };
      }
      return {
        kind: 'RESOLVED',
        disposition: 'SENT',
        state,
        reason: 'The provider confirms it sent this transfer.',
      };
    }

    case 'FAILED': {
      /*
        An attempt we were unsure about, which the provider says it never sent. That IS a
        resolution - but if we had already recorded the money as sent, the two sides contradict
        each other and no worker may choose between them.
      */
      if (local.status === 'SUCCEEDED') {
        return {
          kind: 'FINDING',
          finding: 'PROVIDER_CONTRADICTS_LOCAL',
          state,
          detail:
            'We recorded this transfer as sent; the provider says it did not send it. Nothing has been changed.',
        };
      }
      if (local.status === 'FAILED') {
        return {
          kind: 'AGREES',
          reason: 'We and the provider both say this transfer was not sent.',
        };
      }
      return {
        kind: 'RESOLVED',
        disposition: 'FAILED',
        state,
        reason: 'The provider confirms it did not send this transfer.',
      };
    }

    case 'PENDING':
      // Not a disagreement and not an answer. Ask again later; it is the provider working.
      return {
        kind: 'FINDING',
        finding: 'STILL_UNRESOLVED',
        state,
        detail: 'The provider has this transfer and is still working on it.',
      };

    case 'NOT_FOUND':
      /*
        The tempting inference - "they have never heard of it, so nothing happened, send it" -
        is exactly the one that pays an organizer twice. A lookup can be eventually consistent,
        or keyed on something the create call never returned. Absence is evidence, not a
        clearance, and only someone who knows this provider can say which.
      */
      return {
        kind: 'FINDING',
        finding: 'PROVIDER_HAS_NO_RECORD',
        state,
        detail:
          'The provider has no record under any identifier we hold. This is not proof that nothing was sent.',
      };

    case 'UNKNOWN':
      return {
        kind: 'FINDING',
        finding: 'STILL_UNRESOLVED',
        state,
        detail: 'We asked, and the provider still cannot say what happened.',
      };
  }
}

/**
 * Reconcile one attempt, where that is possible at all.
 *
 * The reader is the ONLY provider capability passed in, and it can read. This is the same
 * narrowing the reversal sweeper uses, and for the same reason: a test can show a thing was not
 * done, whereas a narrower type means it could not be.
 */
export async function reconcileTransferAttempt(
  local: LocalTransferFacts,
  reader: ProviderTransferReader | null,
): Promise<TransferReconciliationOutcome> {
  /*
    A settled attempt holds no open QUESTION - which is why the worker never selects one; see
    `unresolvedAttempts`. But being settled is not a reason to ignore evidence somebody has
    actually gone and fetched: a transfer we recorded as sent, which the provider later says it
    never sent, is the single most important thing this module can catch. So the early exit is
    only for the case where there is nothing to compare against.
  */
  if (!reader) {
    if (!isReconcilable(local.status)) {
      return { kind: 'AGREES', reason: `Attempt is ${local.status}; nothing is in doubt.` };
    }
    /*
      No adapter capability, or no identifier this provider accepts. Recorded rather than
      retried: the whole point is that uncertainty we cannot resolve must stay visible instead
      of being quietly converted into a decision.
    */
    return {
      kind: 'FINDING',
      finding: 'CANNOT_BE_ASKED',
      state: null,
      detail:
        'This provider cannot be asked what became of this transfer, so only a person can establish it.',
    };
  }

  let state: TransferState;
  try {
    state = await reader.getTransferState(lookupFor(local));
  } catch {
    // Asking failed. That is not evidence about the money, so nothing about the money changes.
    return {
      kind: 'FINDING',
      finding: 'STILL_UNRESOLVED',
      state: null,
      detail: 'The provider could not be reached to establish what happened.',
    };
  }

  return classifyTransferEvidence(local, state);
}
