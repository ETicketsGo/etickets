import {
  financeStateOf,
  readCurrency,
  type FinanceEntry,
  type FinanceFeeLine,
  type FinanceMoney,
  type FinanceState,
} from '@eticketsgo/shared-types';

/**
 * One platform-managed payout, read as a FinanceEntry.
 *
 * ── THE AUTHORITY HIERARCHY ────────────────────────────────────────────────────────
 * Two evidence sets describe the same payout, and they are authoritative for different things:
 *
 *   Payout            the stored final totals. gross, bookingFee, paymentFee, refund, net,
 *                     currency, lifecycle. These ARE the money record.
 *   PayoutAllocation   the decomposition and the membership. discount, organizerFee, which
 *                     events, which bookings. Immutable, written in the same transaction.
 *
 * Neither replaces the other. The Payout row cannot explain its own deductions - it never stored
 * `discountMinor` or `organizerFeeMinor`, so `gross - refund - net` gives only their combined
 * effect and cannot prove either component. The allocations can. Conversely the allocations are
 * not the money record, so this never substitutes an allocation-derived total for a stored one.
 *
 * ── WHY THEY ARE RECONCILED RATHER THAN CHOSEN BETWEEN ─────────────────────────────
 * The generator's gate already guarantees they agree at write time. If they ever disagree at read
 * time, something has gone wrong that nobody has noticed - a migration, a manual edit, a bug - and
 * the correct response is not to pick the nicer number. Financial disagreement is evidence, not a
 * formatting problem. So every sum is checked, mismatches are returned, and the entry is marked
 * ATTENTION_REQUIRED rather than repaired.
 *
 * ── PURE AND READ-ONLY ─────────────────────────────────────────────────────────────
 * Rows in, entry out. No database, no provider, no reconciliation, no writes. The caller fetches;
 * this decides what the fetched evidence supports.
 */

/** A payout row, as the caller fetched it. Plain types so this needs no ORM. */
export interface PlatformPayoutRow {
  id: string;
  organizationId: string;
  eventId: string | null;
  currency: string;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  grossMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  refundMinor: number;
  netMinor: number;
  /** Null means the payout predates allocations. See `legacy` handling throughout. */
  allocatedFrom: Date | null;
}

/** One allocation row belonging to the payout above. */
export interface PlatformAllocationRow {
  bookingId: string;
  eventId: string;
  currency: string;
  allocatedNetMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  organizerFeeMinor: number;
  refundShareMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
}

/**
 * Something about this payout's evidence does not hold.
 *
 * Returned alongside the entry rather than thrown: a Finance read must still show the organizer
 * their payout, and hiding a row because its decomposition disagrees would be a worse answer than
 * showing it flagged.
 */
export type FinanceIntegrityCode =
  /** A stored Payout total and the sum of its allocations disagree. */
  | 'TOTALS_DISAGREE'
  /** The allocation equation does not reproduce the payout net. */
  | 'EQUATION_DISAGREES'
  /** `allocatedFrom` is set but no allocations were supplied for it. */
  | 'MISSING_ALLOCATIONS'
  /** An allocation names an event the event-scoped payout does not. */
  | 'ALLOCATION_EVENT_MISMATCH'
  /** An allocation is in a different currency from its payout. */
  | 'ALLOCATION_CURRENCY_MISMATCH'
  /** The payout's status is not one we can map to an organizer-facing state. */
  | 'UNMAPPED_STATUS'
  /** The payout's currency is not readable, so it cannot be compared with anything. */
  | 'CURRENCY_UNREADABLE'
  /**
   * A settlement says money was sent, but no original transfer amount was ever recorded.
   *
   * A LIMITATION, not a contradiction. `release()` now records `Settlement.releasedMinor`, but
   * for most of this platform's history nothing did, so it sits at its schema default of 0 on
   * every row released before that fix. Those rows are deliberately not backfilled, so the
   * amount originally sent is simply not stored for them.
   *
   * Reporting that as a disagreement would mark healthy historical settlements as broken;
   * reporting a zero would state that nothing was sent. Neither is true, so movement is withheld
   * and this says why. Expect it to stop appearing as pre-fix settlements age out.
   */
  | 'MOVEMENT_NOT_RECORDED';

export interface FinanceIntegrityFinding {
  code: FinanceIntegrityCode;
  /** Which quantity disagreed, where that is meaningful. */
  field?: string;
  /** The stored Payout figure. */
  stored?: number;
  /** What the allocations summed to. */
  derived?: number;
  detail: string;
}

export interface PlatformFinanceResult {
  entry: FinanceEntry;
  /** Empty when every check held. Never silently discarded by the producer. */
  integrity: FinanceIntegrityFinding[];
}

interface AllocationSums {
  subtotal: number;
  discount: number;
  organizerFee: number;
  refundShare: number;
  bookingFee: number;
  paymentFee: number;
  net: number;
}

function sumAllocations(rows: readonly PlatformAllocationRow[]): AllocationSums {
  return rows.reduce<AllocationSums>(
    (acc, row) => ({
      subtotal: acc.subtotal + row.subtotalMinor,
      discount: acc.discount + row.discountMinor,
      organizerFee: acc.organizerFee + row.organizerFeeMinor,
      refundShare: acc.refundShare + row.refundShareMinor,
      bookingFee: acc.bookingFee + row.bookingFeeMinor,
      paymentFee: acc.paymentFee + row.paymentFeeMinor,
      net: acc.net + row.allocatedNetMinor,
    }),
    {
      subtotal: 0,
      discount: 0,
      organizerFee: 0,
      refundShare: 0,
      bookingFee: 0,
      paymentFee: 0,
      net: 0,
    },
  );
}

/**
 * Project one payout into a FinanceEntry, with whatever its evidence actually supports.
 *
 * `allocations` must be every allocation belonging to this payout. For an allocation-backed payout
 * an empty array is reported as MISSING_ALLOCATIONS rather than read as "no decomposition", because
 * a caller that forgot to load them would otherwise look identical to a payout that has none.
 */
export function platformFinanceEntry(
  payout: PlatformPayoutRow,
  allocations: readonly PlatformAllocationRow[],
): PlatformFinanceResult {
  const integrity: FinanceIntegrityFinding[] = [];

  const folded = readCurrency(payout.currency);
  if (folded === null) {
    integrity.push({
      code: 'CURRENCY_UNREADABLE',
      field: 'currency',
      detail: 'the payout stores no readable currency, so its money cannot be compared',
    });
  }
  const currency = folded ?? payout.currency.trim().toUpperCase();

  /*
    ── WHAT "LEGACY" DOES AND DOES NOT MEAN ─────────────────────────────────────────
    `allocatedFrom === null` means the payout predates allocations. That costs it its DECOMPOSITION
    always - the row never stored discount or organizerFee. It costs it its ATTRIBUTION only when
    it is a period payout, because an event-scoped payout names its own event on the row and that
    is authoritative regardless of when it was raised.
  */
  const isLegacy = payout.allocatedFrom === null;
  const namesEvent = payout.eventId !== null;

  if (!isLegacy && allocations.length === 0) {
    integrity.push({
      code: 'MISSING_ALLOCATIONS',
      detail:
        'allocatedFrom is set, so this payout recorded its membership, but no allocations were supplied',
    });
  }

  const sums = sumAllocations(allocations);
  /*
    Decomposition is only trustworthy when the payout actually recorded allocations AND they were
    supplied. A legacy payout, or an allocation-backed one whose rows are missing, gets no
    discount and no organizer fee - ABSENT, never zero. Absence says the source cannot prove the
    value; zero says the source proves it was zero, and those are different financial statements.
  */
  const decomposable = !isLegacy && allocations.length > 0;

  if (decomposable) {
    // Stored totals versus immutable component evidence. Exact integers, no tolerance.
    const checks: Array<[string, number, number]> = [
      ['grossMinor', payout.grossMinor, sums.subtotal],
      ['bookingFeeMinor', payout.bookingFeeMinor, sums.bookingFee],
      ['paymentFeeMinor', payout.paymentFeeMinor, sums.paymentFee],
      ['refundMinor', payout.refundMinor, sums.refundShare],
      ['netMinor', payout.netMinor, sums.net],
    ];
    for (const [field, stored, derived] of checks) {
      if (stored !== derived) {
        integrity.push({
          code: 'TOTALS_DISAGREE',
          field,
          stored,
          derived,
          detail: `stored ${field} is ${stored} but its allocations sum to ${derived}`,
        });
      }
    }

    /*
      The equation, checked from the components rather than from allocatedNetMinor. This is what
      proves bookingFee and paymentFee do NOT participate: including either would break it by
      exactly their amount.
    */
    const fromComponents = sums.subtotal - sums.discount - sums.organizerFee - sums.refundShare;
    if (fromComponents !== payout.netMinor) {
      integrity.push({
        code: 'EQUATION_DISAGREES',
        field: 'netMinor',
        stored: payout.netMinor,
        derived: fromComponents,
        detail:
          'subtotal - discount - organizerFee - refundShare does not reproduce the stored net',
      });
    }

    for (const row of allocations) {
      if (namesEvent && row.eventId !== payout.eventId) {
        integrity.push({
          code: 'ALLOCATION_EVENT_MISMATCH',
          field: 'eventId',
          detail: `allocation for booking ${row.bookingId} names event ${row.eventId}, but the payout names ${payout.eventId}`,
        });
      }
      if (readCurrency(row.currency) !== folded) {
        integrity.push({
          code: 'ALLOCATION_CURRENCY_MISMATCH',
          field: 'currency',
          detail: `allocation for booking ${row.bookingId} is in ${row.currency}, not ${payout.currency}`,
        });
      }
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────
  const mapped = financeStateOf('PAYOUT', payout.status);
  if (mapped === null) {
    integrity.push({
      code: 'UNMAPPED_STATUS',
      field: 'status',
      detail: `payout status ${payout.status} has no organizer-facing state, so none is guessed`,
    });
  }
  /*
    An integrity finding outranks the mapped state. A PAID payout whose evidence contradicts
    itself is not simply paid - somebody has to look. `sourceStatus` keeps the original one field
    away, so nothing is lost.
  */
  const state: FinanceState =
    integrity.length > 0 ? 'ATTENTION_REQUIRED' : (mapped as FinanceState);

  // ── money ────────────────────────────────────────────────────────────────────────
  const fees: FinanceFeeLine[] = [
    /*
      Stored on the Payout row, so a zero here is a PROVEN zero and worth emitting. Both are
      reported and NOT deducted: `subtotalMinor` is already the ticket value net to the organizer
      and the customer bears these on top. See currency-settlement.calculator.ts.
    */
    { key: 'BOOKING', amountMinor: payout.bookingFeeMinor, deducted: false },
    { key: 'PAYMENT_PROCESSING', amountMinor: payout.paymentFeeMinor, deducted: false },
  ];
  if (decomposable) {
    // The one platform fee that actually comes out of the organizer's money.
    fees.push({ key: 'PLATFORM', amountMinor: sums.organizerFee, deducted: true });
  }

  const money: FinanceMoney = {
    // Stored, authoritative, and the only quantity both paths genuinely compute.
    organizerNetMinor: payout.netMinor,
    grossFaceValueMinor: payout.grossMinor,
    refundsMinor: payout.refundMinor,
    fees,
    // `discountMinor` and the PLATFORM fee line are absent unless allocations prove them.
    ...(decomposable ? { discountMinor: sums.discount } : {}),
  };

  // ── attribution ──────────────────────────────────────────────────────────────────
  const coveredEventIds =
    !namesEvent && decomposable
      ? [...new Set(allocations.map((a) => a.eventId))].sort()
      : undefined;

  const entry: FinanceEntry = {
    sourceType: 'PAYOUT',
    sourceId: payout.id,
    sourceStatus: payout.status,
    state,
    organizationId: payout.organizationId,
    currency,
    /*
      An event-scoped payout names its event on the row, which is authoritative whenever it was
      raised. A period payout proves its events through allocations, or proves nothing.
    */
    attribution: namesEvent || coveredEventIds !== undefined ? 'AUTHORITATIVE' : 'UNKNOWN_LEGACY',
    eventId: payout.eventId,
    ...(coveredEventIds !== undefined ? { coveredEventIds } : {}),
    periodStart: payout.periodStart?.toISOString() ?? null,
    periodEnd: payout.periodEnd?.toISOString() ?? null,
    money,
  };

  return { entry, integrity };
}
