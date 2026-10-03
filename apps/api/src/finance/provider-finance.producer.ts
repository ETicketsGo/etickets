import {
  financeStateOf,
  readCurrency,
  type FinanceEntry,
  type FinanceFeeLine,
  type FinanceMoney,
  type FinanceMovement,
  type FinanceState,
} from '@eticketsgo/shared-types';
import type { FinanceIntegrityFinding } from './platform-finance.producer';

/**
 * One provider-managed settlement, read as a FinanceEntry.
 *
 * ── ENTITLEMENT AND MOVEMENT ARE DIFFERENT QUESTIONS ───────────────────────────────
 * `organizerNetMinor` has ONE meaning at every lifecycle stage: what this settlement entitles
 * the organizer to. It never becomes "what they are holding" once money moves. Movement lives in
 * `movement`, separately, so no field answers two financial questions depending on status.
 *
 * ── WHY NOT payableMinor ───────────────────────────────────────────────────────────
 * `payableMinor` looks like the entitlement and is not. Its equation is
 *
 *     base    = max(0, grossOrganizerNet − refunds − disputes − priorTransferred)
 *     payable = max(0, base − reserve)
 *
 * which is a disbursement instruction for ONE transfer: it subtracts what was already sent, it
 * subtracts the reserve the organizer is still entitled to, and it clamps at zero. Worse, it is
 * written only inside `release()`, so for every PENDING / HELD / ELIGIBLE / APPROVED settlement it
 * is still the schema default 0. Using it would have reported zero entitlement to every organizer
 * awaiting payment.
 *
 * `grossSalesMinor` is the entitlement. It is recomputed on every settlement upsert as
 * `Σ payment.organizerNetMinor` over CAPTURED payments - already net of the platform fee, which
 * `computeMarketplaceSplit` took off per payment - and it deliberately includes since-refunded
 * payments, because refunds are deducted separately through `refundsMinor`.
 *
 * ── ZERO IS NOT THE SAME AS UNSET ──────────────────────────────────────────────────
 * `refundsMinor`, `disputesMinor` and `reserveMinor` are NOT maintained by the upsert. They stay
 * at 0 until `release()` computes them. So before release a 0 there means "never calculated", and
 * emitting it would assert "no refunds" about a settlement whose refunds nobody has worked out.
 * They are therefore absent until the settlement has actually been released.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────────────
 * Rows in, entry out. No provider calls, no reconciliation execution, no money movement, no
 * ownership mutation. Reversal evidence arrives already reconciled: duplicate and out-of-order
 * provider evidence is the reconciliation engine's problem and was closed before this existed.
 */

/** A settlement row, as the caller fetched it. */
export interface ProviderSettlementRow {
  id: string;
  organizationId: string;
  eventId: string;
  currency: string;
  status: string;
  /** Σ payment.organizerNetMinor over CAPTURED payments. The entitlement. */
  grossSalesMinor: number;
  /** Σ payment.platformFeeMinor. Already off the figure above. */
  platformFeesMinor: number;
  /** Unmaintained before release - see the note on zero versus unset. */
  refundsMinor: number;
  disputesMinor: number;
  reserveMinor: number;
  /** Total ever sent out. Monotonic. */
  releasedMinor: number;
  /** Still out after confirmed reversals. */
  transferredMinor: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What reconciliation currently says about this settlement's reversals.
 *
 * Deliberately not the attempts themselves. The producer needs to know whether ambiguity exists,
 * not to re-derive money from attempt rows - the settlement's own ledger already reflects
 * confirmed reversals and nothing else.
 */
export interface ProviderReversalEvidence {
  /**
   * Attempts in REQUESTED, PROCESSING or UNKNOWN.
   *
   * None of those proves money moved, so none affects an amount here. They make the entry need a
   * person.
   */
  unresolvedCount: number;
  /** Reconciliation found provider evidence disagreeing with our ledger. */
  reconciliationMismatch: boolean;
}

export interface ProviderFinanceResult {
  entry: FinanceEntry;
  integrity: FinanceIntegrityFinding[];
}

/** Statuses after which money has actually been sent, so the release ledger should be populated. */
const RELEASED_STATUSES = new Set([
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'REVERSED',
]);

export function providerFinanceEntry(
  settlement: ProviderSettlementRow,
  evidence: ProviderReversalEvidence = { unresolvedCount: 0, reconciliationMismatch: false },
): ProviderFinanceResult {
  const integrity: FinanceIntegrityFinding[] = [];

  const folded = readCurrency(settlement.currency);
  if (folded === null) {
    integrity.push({
      code: 'CURRENCY_UNREADABLE',
      field: 'currency',
      detail: 'the settlement stores no readable currency, so its money cannot be compared',
    });
  }
  const currency = folded ?? settlement.currency.trim().toUpperCase();

  const released = RELEASED_STATUSES.has(settlement.status);

  // ── movement integrity ───────────────────────────────────────────────────────────
  /*
    ── WHY THIS IS NOT A SIMPLE COMPARISON ───────────────────────────────────────────
    `releasedMinor` is written by NOTHING. The release path sets status, providerTransferId,
    reserveMinor, payableMinor and transferredMinor - never releasedMinor - so it stays at its
    schema default of 0, and the rest of the settlement service reads it as
    `releasedMinor || transferredMinor`.

    So `transferredMinor > releasedMinor` is true of EVERY healthy released settlement. Treating
    that as a contradiction would mark real money as broken. Only a NON-ZERO released figure
    smaller than what is still out is genuinely impossible.
  */
  const movementRecorded = settlement.releasedMinor > 0;

  if (movementRecorded && settlement.transferredMinor > settlement.releasedMinor) {
    integrity.push({
      code: 'TOTALS_DISAGREE',
      field: 'transferredMinor',
      stored: settlement.transferredMinor,
      derived: settlement.releasedMinor,
      detail: 'more money is recorded as still out than was ever transferred out',
    });
  }
  if (settlement.releasedMinor < 0 || settlement.transferredMinor < 0) {
    integrity.push({
      code: 'TOTALS_DISAGREE',
      field: 'releasedMinor',
      stored: settlement.releasedMinor,
      derived: settlement.transferredMinor,
      detail: 'a negative movement amount is not a possible state',
    });
  }
  if (released && !movementRecorded) {
    /*
      The ordinary case today, not an anomaly. Reported so a reader knows the movement is MISSING
      rather than zero, and deliberately not as a disagreement - nothing here contradicts anything.
    */
    integrity.push({
      code: 'MOVEMENT_NOT_RECORDED',
      field: 'releasedMinor',
      detail:
        'the amount originally transferred was never recorded, so this settlement cannot describe what moved',
    });
  }
  if (!released && settlement.releasedMinor > 0) {
    integrity.push({
      code: 'TOTALS_DISAGREE',
      field: 'releasedMinor',
      stored: settlement.releasedMinor,
      detail: `status ${settlement.status} says money has not been sent, but a release is recorded`,
    });
  }

  /*
    Movement is reported only once a release has actually happened. Before that there is nothing
    to report and zeroes would assert that nothing moved - true today, but indistinguishable from
    a settlement whose movement nobody recorded.
  */
  const movement: FinanceMovement | undefined =
    released && movementRecorded
      ? {
          transferredOutMinor: settlement.releasedMinor,
          recoveredMinor: Math.max(0, settlement.releasedMinor - settlement.transferredMinor),
          stillOutMinor: settlement.transferredMinor,
        }
      : undefined;

  // ── lifecycle, derived independently of every amount ─────────────────────────────
  const mapped = financeStateOf('SETTLEMENT', settlement.status);
  if (mapped === null) {
    integrity.push({
      code: 'UNMAPPED_STATUS',
      field: 'status',
      detail: `settlement status ${settlement.status} has no organizer-facing state, so none is guessed`,
    });
  }
  /*
    Ambiguity and disagreement both need a person, and neither may present as a finished state.
    An unresolved reversal means money may or may not have come back; showing PAID would claim we
    know it did not.
  */
  /*
    A LIMITATION is not a reason to call somebody. MOVEMENT_NOT_RECORDED is true of every released
    settlement today, so marking them all ATTENTION_REQUIRED would make the state meaningless
    exactly where it matters most.
  */
  const contradictions = integrity.filter((f) => f.code !== 'MOVEMENT_NOT_RECORDED');
  const needsPerson =
    contradictions.length > 0 || evidence.unresolvedCount > 0 || evidence.reconciliationMismatch;
  const state: FinanceState = needsPerson ? 'ATTENTION_REQUIRED' : (mapped as FinanceState);

  // ── money ────────────────────────────────────────────────────────────────────────
  const fees: FinanceFeeLine[] = [
    /*
      One honest aggregate. The provider path stores only platformFeesMinor and cannot split it
      into processing, convenience and platform shares - so it does not pretend to. It IS
      deducted: it came off each payment before organizerNetMinor was computed.
    */
    { key: 'PLATFORM_COMBINED', amountMinor: settlement.platformFeesMinor, deducted: true },
  ];

  const money: FinanceMoney = {
    // One meaning at every stage: what this settlement entitles the organizer to.
    organizerNetMinor: settlement.grossSalesMinor,
    /*
      No grossFaceValueMinor. This path never records the pre-fee ticket value as an
      organizer-facing gross - grossSalesMinor is already net of the platform fee despite its
      name - and adding platformFees back would invent a quantity that excludes tax and
      corresponds to nothing stored.
    */
    fees,
    // Absent before release: a 0 there means nobody computed it.
    ...(released ? { refundsMinor: settlement.refundsMinor } : {}),
    ...(released && settlement.disputesMinor + settlement.reserveMinor > 0
      ? // Disputes and reserve, the two provider-side concepts with no platform equivalent.
        { adjustmentsMinor: settlement.disputesMinor + settlement.reserveMinor }
      : {}),
  };

  const entry: FinanceEntry = {
    sourceType: 'SETTLEMENT',
    sourceId: settlement.id,
    sourceStatus: settlement.status,
    state,
    organizationId: settlement.organizationId,
    currency,
    // A settlement is per event per currency, so its attribution is never in doubt.
    attribution: 'AUTHORITATIVE',
    eventId: settlement.eventId,
    // Not a period concept. A settlement covers one event, not a window.
    periodStart: null,
    periodEnd: null,
    money,
    ...(movement !== undefined ? { movement } : {}),
  };

  return { entry, integrity };
}
