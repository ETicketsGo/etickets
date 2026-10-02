import type { CURRENCY_WILDCARD } from './finance-currency';

/**
 * One unit of organizer revenue, as a READ model over the two money systems.
 *
 * ── WHY A PROJECTION AND NOT A TABLE ───────────────────────────────────────────────
 * `Payout` and `Settlement` are not two spellings of one thing. A `Settlement` is one row per
 * event per currency, with an approver and a provider transfer id. A `Payout` is an organization
 * ledger row that may cover a PERIOD across many events, settled by a bank transfer somebody
 * makes by hand. Merging them into one table loses information on whichever side is flattened,
 * so nothing here is persisted: both tables stay authoritative and this is how they are read
 * together.
 *
 * ── THE TRAP THIS TYPE EXISTS TO MAKE IMPOSSIBLE ───────────────────────────────────
 * The two systems use the same WORDS for different quantities. `Payout.grossMinor` is
 * `sum(booking.subtotalMinor)` - ticket face value, before fees. `Settlement.grossSalesMinor` is
 * `sum(payment.organizerNetMinor)` - the organizer's NET share, after the platform fee has
 * already come off. A single field called `gross` fed by both would overstate one path and
 * understate the other, and the total would look entirely reasonable.
 *
 * So there is no shared `gross`. The one quantity both systems genuinely compute is what the
 * organizer is owed, and that is the only required money field. Everything else is optional and
 * ABSENT when the source cannot prove it - never zero. Zero is a claim; absent is the truth.
 */

/** Which of the two systems owns this revenue. Never both - see the one-path invariant. */
export type FinanceSourceType = 'PAYOUT' | 'SETTLEMENT';

/**
 * How well this entry's EVENT attribution is known. Says nothing about its amount.
 *
 * ── WHY THIS IS A FIELD AND NOT A RULE ABOUT OTHER FIELDS ──────────────────────────
 * The distinction already existed, encoded across two fields: `eventId` set, or
 * `coveredEventIds` present, meant proven; both absent meant a payout that predates allocations
 * and whose membership nobody knows. That rule was correct and completely invisible. A producer
 * could emit an entry with no events for the wrong reason and nothing would notice, and every
 * consumer had to re-derive the convention to read it.
 *
 * So the entry states it. An amount can be authoritative while its attribution is not - that is
 * the normal condition of a legacy payout, and the whole reason this type exists.
 *
 * NOT_APPLICABLE was considered and deliberately left out: nothing in either path can currently
 * produce a financial entry that is genuinely not about events, and a state with no producer is
 * a state nobody tests. Add it when something emits it.
 */
export type FinanceAttribution =
  /**
   * The events are proven. Either the source names one, or its allocations do.
   *
   * An AUTHORITATIVE entry with an EMPTY `coveredEventIds` is a real and different claim: the
   * allocations were read and they cover no events. Not the same as nobody having looked.
   */
  | 'AUTHORITATIVE'
  /**
   * The source predates allocations. Its AMOUNT is authoritative; its event membership is not.
   *
   * Never to be read as "covers nothing". A legacy period payout may well cover the event
   * somebody is about to release, and treating absence of evidence as evidence of absence is
   * what would pay that revenue twice.
   */
  | 'UNKNOWN_LEGACY';

/**
 * The organizer-facing lifecycle, normalized across two enums that stay in persistence.
 *
 * `PayoutStatus` has 4 values and `SettlementStatus` has 10. They are NOT merged into a shared
 * database enum; this is a reading of them, and `sourceStatus` always travels alongside so the
 * original is one field away.
 */
export type FinanceState =
  /** Money exists and is not yet moving. */
  | 'PENDING'
  /** Committed, not yet landed. */
  | 'IN_PROGRESS'
  /** Money reached the organizer. */
  | 'PAID'
  /** Some proceeds were returned after the money moved. Kept distinct from PAID on purpose. */
  | 'PARTIALLY_REFUNDED'
  /** Somebody must act. */
  | 'ATTENTION_REQUIRED';

/**
 * A named fee line.
 *
 * A list, not a fixed set of columns, because the two paths can prove different things. The
 * platform path stores `bookingFeeMinor` and `paymentFeeMinor` separately; the provider path has
 * only `platformFeesMinor`, one number, and CANNOT be split into the two. The owner's rule is
 * that payment processing is its own line and never folded into convenience fees - so where a
 * path cannot prove the split, it emits one honest line rather than two invented ones.
 */
export interface FinanceFeeLine {
  /** Stable key for grouping and translation. Never shown raw. */
  key: 'BOOKING' | 'PAYMENT_PROCESSING' | 'PLATFORM' | 'PLATFORM_COMBINED';
  amountMinor: number;
  /**
   * Whether this line was taken OUT of `organizerNetMinor`, or is merely reported.
   *
   * ── WHY A FEE LINE HAS TO SAY THIS ─────────────────────────────────────────────────
   * On the platform path they are not all the same. `organizerFeeMinor` is deducted;
   * `bookingFeeMinor` and `paymentFeeMinor` are REPORTED and deliberately not deducted, because
   * `subtotalMinor` is already the ticket value net to the organizer and the customer bears those
   * two on top. See `currency-settlement.calculator.ts`.
   *
   * Without this field a consumer has every reason to sum the lines and subtract them from gross,
   * which understates what the organizer is owed by exactly the customer-borne fees - a wrong
   * number that looks entirely plausible. The key alone implies it today, and relying on that is
   * the same invisible convention `attribution` just replaced.
   */
  deducted: boolean;
}

/**
 * The money on one entry, in the currency's minor unit.
 *
 * Only `organizerNetMinor` is required. Every other field is absent when its source cannot prove
 * it, which is why they are optional rather than defaulted to zero: a Finance screen that shows
 * a confident 0 where it means "we do not know" is the failure this whole model exists to avoid.
 */
export interface FinanceMoney {
  /**
   * What the organizer is owed or was paid, after everything that comes off it.
   *
   * The only quantity BOTH systems genuinely compute: `Payout.netMinor` on one side, and the
   * settlement's payable or transferred amount on the other.
   */
  organizerNetMinor: number;
  /**
   * Ticket face value before anything comes off.
   *
   * Absent on the provider path, which never records it - `grossSalesMinor` there is already net
   * of the platform fee, despite its name.
   */
  grossFaceValueMinor?: number;
  discountMinor?: number;
  fees?: FinanceFeeLine[];
  refundsMinor?: number;
  /** Disputes and reserve. Provider-side concepts with no platform-ledger equivalent. */
  adjustmentsMinor?: number;
}

/** One unit of organizer revenue, read from whichever system owns it. */
export interface FinanceEntry {
  sourceType: FinanceSourceType;
  /** The row this was read from, so any figure can be traced back to it. */
  sourceId: string;
  /** The source's own status, unmapped. Traceability, never shown to an organizer. */
  sourceStatus: string;
  state: FinanceState;
  organizationId: string;
  /** ISO-4217, upper case. Folded by `readCurrency`; never the wildcard. */
  currency: Exclude<string, typeof CURRENCY_WILDCARD>;
  /**
   * Whether the event attribution below can be relied on.
   *
   * Required, so a producer has to make the claim rather than leave it to be inferred from what
   * it happened to omit.
   */
  attribution: FinanceAttribution;
  /** The event, when the entry is about one. Null for a period payout spanning many. */
  eventId: string | null;
  /**
   * The events a PERIOD payout covers, where the source can prove it.
   *
   * ── THE DISTINCTION THAT MATTERS ─────────────────────────────────────────────────
   * An array - including an empty one - means membership is PROVEN, read from the payout's
   * allocations. `undefined` means the source does not record it, so membership is genuinely
   * UNKNOWN. These are different facts and must never be collapsed.
   *
   * Reading unknown as empty is what would let a release decide no payout covers an event when a
   * legacy payout already claimed it. A payout raised before allocations existed has
   * `allocatedFrom` null and belongs here as `undefined`, not `[]`.
   *
   * Absent on an event-level entry, which names its event directly.
   */
  coveredEventIds?: readonly string[];
  /** The period, when the entry covers one. Null for an event settlement. */
  periodStart: string | null;
  periodEnd: string | null;
  money: FinanceMoney;
}

/**
 * Why this entry's attribution and its events disagree, or null when they are consistent.
 *
 * ── WHY A CHECK AND NOT JUST A TYPE ────────────────────────────────────────────────
 * TypeScript can require the field. It cannot require that `UNKNOWN_LEGACY` comes with no events
 * - that is a relationship between three fields, and the combinations it forbids are exactly the
 * ones that would be dangerous:
 *
 *   UNKNOWN_LEGACY naming events        claims proof it does not have
 *   AUTHORITATIVE naming nothing        indistinguishable from legacy, which is the collapse
 *                                       this whole distinction exists to prevent
 *
 * Returns a sentence rather than a boolean so a producer's test failure says what is wrong.
 */
export function financeAttributionError(entry: FinanceEntry): string | null {
  const names = entry.eventId !== null;
  const covers = entry.coveredEventIds !== undefined;

  if (entry.attribution === 'UNKNOWN_LEGACY') {
    if (names) return 'UNKNOWN_LEGACY entry names an eventId, which claims proof it does not have';
    if (covers) {
      return 'UNKNOWN_LEGACY entry carries coveredEventIds, which claims proof it does not have';
    }
    return null;
  }

  // AUTHORITATIVE
  if (!names && !covers) {
    return 'AUTHORITATIVE entry proves no events: it is indistinguishable from UNKNOWN_LEGACY';
  }
  if (names && covers) {
    /*
      Both would be two answers to one question, and a reader has no basis for choosing. An
      event-scoped source names its event; a period source lists what its allocations proved.
    */
    return 'entry sets both eventId and coveredEventIds, so its attribution has two answers';
  }
  return null;
}

/** Every event this entry authoritatively claims. Empty when attribution is not authoritative. */
export function financeClaimedEvents(entry: FinanceEntry): readonly string[] {
  if (entry.attribution !== 'AUTHORITATIVE') return [];
  if (entry.eventId !== null) return [entry.eventId];
  return entry.coveredEventIds ?? [];
}

const PAYOUT_STATES: Record<string, FinanceState> = {
  PENDING: 'PENDING',
  SCHEDULED: 'IN_PROGRESS',
  PAID: 'PAID',
  FAILED: 'ATTENTION_REQUIRED',
};

const SETTLEMENT_STATES: Record<string, FinanceState> = {
  PENDING: 'PENDING',
  HELD: 'PENDING',
  ELIGIBLE: 'PENDING',
  APPROVED: 'IN_PROGRESS',
  TRANSFER_PROCESSING: 'IN_PROGRESS',
  TRANSFERRED: 'PAID',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  BLOCKED: 'ATTENTION_REQUIRED',
  FAILED: 'ATTENTION_REQUIRED',
  /*
    REVERSED is ATTENTION_REQUIRED, not PAID and not PENDING. Money went out and came back, and
    the status alone does not say WHY - an administrative correction leaves the organizer unpaid,
    a customer refund means the revenue no longer exists. Until an explicit financial disposition
    exists, a person has to look.
  */
  REVERSED: 'ATTENTION_REQUIRED',
};

/**
 * The organizer-facing state for a source row, or null if the status is unknown to us.
 *
 * Null rather than a guess: an unmapped status is a provider or a migration adding a state we
 * have not met, and showing it as PENDING would tell an organizer their money is on its way when
 * nobody knows that.
 */
export function financeStateOf(
  sourceType: FinanceSourceType,
  sourceStatus: string,
): FinanceState | null {
  const table = sourceType === 'PAYOUT' ? PAYOUT_STATES : SETTLEMENT_STATES;
  return table[sourceStatus] ?? null;
}
