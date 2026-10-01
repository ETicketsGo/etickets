import type { FinanceEntry } from './finance-entry';
import { readCurrency } from './finance-currency';

/**
 * The invariant every unified Finance reader must satisfy.
 *
 *   Every unit of organizer revenue appears through exactly one authoritative settlement path.
 *
 * ── WHY IT IS WRITTEN AS CODE AND NOT AS A SENTENCE ────────────────────────────────
 * The platform ledger and the provider settlement path can both describe the same event's money.
 * Today they are held apart by `SETTLEMENT_CLAIMED_STATUSES` in `payouts.service.ts`, which
 * excludes whole events from the ledger once a provider transfer has claimed them, read inside
 * the same transaction as the sums. That guard is correct and this does not replace it.
 *
 * What this adds is a check any PRODUCER of `FinanceEntry` can be held to, before its output
 * reaches a screen. A reader that breaks the invariant does not crash: it quietly shows an
 * organizer the same revenue twice, and the total looks plausible. The only way to catch that is
 * to state the rule as something executable and run it against real output.
 */

/** One event's revenue claimed by both paths at once. */
export interface OnePathViolation {
  organizationId: string;
  currency: string;
  eventId: string;
  /** The entries that disagree about who owns it. Both are included, so the report is actionable. */
  entries: FinanceEntry[];
}

/**
 * Every event whose revenue is claimed by BOTH paths, in the entries given.
 *
 * Empty means the invariant holds for what it can see. See `UNCHECKABLE_BY_DESIGN` for what it
 * cannot, which is not a gap in this function but a gap in the data model.
 */
export function onePathViolations(entries: readonly FinanceEntry[]): OnePathViolation[] {
  /** organizationId + currency + eventId -> the entries claiming it, by source. */
  const claims = new Map<string, Map<FinanceEntry['sourceType'], FinanceEntry[]>>();

  for (const entry of entries) {
    // A period payout names no event, so it cannot be compared here. See the note below.
    if (entry.eventId === null) continue;
    const currency = readCurrency(entry.currency);
    if (currency === null) continue;

    const key = `${entry.organizationId}\u0000${currency}\u0000${entry.eventId}`;
    const bySource = claims.get(key) ?? new Map<FinanceEntry['sourceType'], FinanceEntry[]>();
    bySource.set(entry.sourceType, [...(bySource.get(entry.sourceType) ?? []), entry]);
    claims.set(key, bySource);
  }

  const violations: OnePathViolation[] = [];
  for (const [key, bySource] of claims) {
    if (bySource.size < 2) continue;
    const [organizationId, currency, eventId] = key.split('\u0000');
    violations.push({
      organizationId,
      currency,
      eventId,
      entries: [...bySource.values()].flat(),
    });
  }
  return violations;
}

/** True when no event in `entries` is claimed by both paths. */
export function holdsOnePath(entries: readonly FinanceEntry[]): boolean {
  return onePathViolations(entries).length === 0;
}

/**
 * What this check CANNOT see, stated so nobody mistakes a pass for a proof.
 *
 * A `Payout` may cover a PERIOD across many events and carries no link to the bookings inside it
 * - there is no `PayoutLine` and no `Booking.payoutId`, so the rows it was built from can only be
 * re-derived by running the same query again. A period payout therefore has `eventId: null`, and
 * an overlap between it and an event-level settlement is INVISIBLE here: the entry simply does
 * not say which events it contains.
 *
 * So a clean result means "no event-level double claim", not "no double claim". Closing the gap
 * needs a payout-to-booking link or a stored derivation snapshot, which is a schema change and an
 * owner decision - not something this function should paper over by guessing at date ranges.
 */
export const UNCHECKABLE_BY_DESIGN =
  'A period payout carries no link to the events inside it, so an overlap between a period payout and an event settlement cannot be detected from entries alone.';
