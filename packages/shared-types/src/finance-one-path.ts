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
 *
 * ── WHAT CHANGED WHEN ALLOCATIONS ARRIVED ──────────────────────────────────────────
 * A period payout used to be invisible to this check. It carried no link to the bookings inside
 * it, so an overlap between a period payout and an event settlement could not be detected at
 * all, and a clean result meant only "no event-level double claim".
 *
 * `PayoutAllocation` closed that. A payout raised under the allocation regime can now say which
 * events it covers, and this expands it into those events and checks each one. What remains
 * unknowable is the LEGACY case - payouts raised before allocations existed - and that is
 * reported per entry rather than hidden behind a constant, because a caller must not be able to
 * read "no violations" without also seeing what could not be checked.
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
 * Why an entry could not be checked.
 *
 * One reason, because there is only one: a period payout that does not record its membership.
 * Adding reasons nothing branches on would only make the report harder to act on.
 */
export type MembershipGapReason = 'UNKNOWN_LEGACY_MEMBERSHIP';

/** An entry whose revenue cannot be attributed to events, so the invariant is unproven for it. */
export interface MembershipGap {
  organizationId: string;
  currency: string;
  reason: MembershipGapReason;
  /** The payout itself, so the gap can be chased to a row rather than merely counted. */
  entry: FinanceEntry;
}

/** What one set of entries can and cannot prove about the invariant. */
export interface OnePathReport {
  /** Events claimed by both paths. Empty means none were found AMONG WHAT COULD BE CHECKED. */
  violations: OnePathViolation[];
  /**
   * Entries whose membership is unknown, so no conclusion about them is available.
   *
   * Non-empty does NOT mean something is wrong. It means something is unproven, which is a
   * different thing and the reason it is reported separately rather than folded into
   * `violations`.
   */
  gaps: MembershipGap[];
}

/**
 * Which events an entry claims, or null when it cannot say.
 *
 * Null is the legacy case and is deliberately NOT an empty list: an empty list is a claim that
 * the payout covers nothing, and nothing in the data supports that claim.
 */
function claimedEvents(entry: FinanceEntry): string[] | null {
  if (entry.eventId !== null) return [entry.eventId];
  if (entry.coveredEventIds === undefined) return null;
  return [...entry.coveredEventIds];
}

/**
 * Every event whose revenue is claimed by BOTH paths, and every entry that could not be checked.
 *
 * Both halves are returned together on purpose. A function that returned only the violations
 * would let a caller conclude the invariant holds when half the entries were never examined -
 * which is exactly the mistake the old `UNCHECKABLE_BY_DESIGN` note existed to warn about and
 * could not prevent.
 */
export function onePathReport(entries: readonly FinanceEntry[]): OnePathReport {
  /** organizationId + currency + eventId -> the entries claiming it, by source. */
  const claims = new Map<string, Map<FinanceEntry['sourceType'], FinanceEntry[]>>();
  const gaps: MembershipGap[] = [];

  for (const entry of entries) {
    const currency = readCurrency(entry.currency);
    // An unreadable currency cannot be compared against anything, including itself.
    if (currency === null) continue;

    const events = claimedEvents(entry);
    if (events === null) {
      gaps.push({
        organizationId: entry.organizationId,
        currency,
        reason: 'UNKNOWN_LEGACY_MEMBERSHIP',
        entry,
      });
      continue;
    }

    for (const eventId of events) {
      const key = `${entry.organizationId}\u0000${currency}\u0000${eventId}`;
      const bySource = claims.get(key) ?? new Map<FinanceEntry['sourceType'], FinanceEntry[]>();
      bySource.set(entry.sourceType, [...(bySource.get(entry.sourceType) ?? []), entry]);
      claims.set(key, bySource);
    }
  }

  const violations: OnePathViolation[] = [];
  for (const [key, bySource] of claims) {
    /*
      Two entries of the SAME source are not a cross-path double claim. Two payouts covering one
      event is the cursor's business - a corrective payout legitimately revisits a booking an
      earlier payout included - and flagging it here would make the check cry wolf about the
      ordinary case.
    */
    if (bySource.size < 2) continue;
    const [organizationId, currency, eventId] = key.split('\u0000');
    violations.push({
      organizationId,
      currency,
      eventId,
      entries: [...bySource.values()].flat(),
    });
  }
  return { violations, gaps };
}

/**
 * Every event claimed by both paths, in the entries given.
 *
 * Kept for callers that only want the violations. Prefer `onePathReport`, which also says what it
 * could not check - this function cannot distinguish "nothing wrong" from "nothing examined".
 */
export function onePathViolations(entries: readonly FinanceEntry[]): OnePathViolation[] {
  return onePathReport(entries).violations;
}

/**
 * True when no event in `entries` is claimed by both paths.
 *
 * Deliberately says nothing about the gaps. A caller that needs "and everything was checkable"
 * must use `provesOnePath`, because conflating the two is how an unproven result becomes a PASS.
 */
export function holdsOnePath(entries: readonly FinanceEntry[]): boolean {
  return onePathReport(entries).violations.length === 0;
}

/**
 * True only when the invariant holds AND every entry could be checked.
 *
 * This is the one a release gate should use. `holdsOnePath` answers "did we find a double
 * claim"; this answers "can we show there is none", and a legacy payout makes the second answer
 * no while leaving the first answer yes.
 */
export function provesOnePath(entries: readonly FinanceEntry[]): boolean {
  const report = onePathReport(entries);
  return report.violations.length === 0 && report.gaps.length === 0;
}

/**
 * What remains unknowable, and why it is no longer a design limitation.
 *
 * It used to be: a `Payout` had no link to the bookings inside it, so a period payout's events
 * could only be re-derived by running the generator's query again. `PayoutAllocation` records
 * them as the payout is written, and `Payout.allocatedFrom` marks which payouts carry that
 * record.
 *
 * So the remaining gap is historical, not structural, and it does not close by itself: payouts
 * raised before allocations existed have no membership and reconstructing one would be inventing
 * evidence. They are reported as `UNKNOWN_LEGACY_MEMBERSHIP` and must be treated as possibly
 * covering any event in their period.
 */
export const UNKNOWN_LEGACY_MEMBERSHIP =
  'A payout raised before allocations existed records no event membership. Its revenue may cover any event in its period, and that cannot be narrowed without inventing evidence.';
