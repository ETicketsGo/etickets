import { applicableTiers, type FeePlace } from '../pricing/fee-calculator';

/**
 * Whether a booking-fee schedule still prices every order once a band is taken away.
 *
 * ── WHY A DELETE IS CHECKED AT ALL ─────────────────────────────────────────────────
 * Two silent outcomes follow from removing the wrong band, and neither throws at checkout:
 *
 *  - NO BAND LEFT. `PricingService.loadTiers` falls back to `DEFAULT_FEE_TIERS` - the India
 *    rupee defaults - when nothing applies. Deleting the last USD band would charge every US
 *    order 500 minor units ("$5.00") from the India table, with nobody having chosen that.
 *  - A HOLE. An order whose amount no band covers is priced by the NEAREST band by amount, so a
 *    deleted middle band quietly hands its range to a neighbour that was set for other orders.
 *
 * So a delete is refused when the schedule that prices the band's own place would be left
 * empty, or would gain an uncovered range it did not already have. Holes that were already
 * there are not this delete's doing and do not block it (they are reported by the same maths).
 *
 * ── WHAT "COVERED" MEANS FOR WHOLE-UNIT BOUNDARIES ─────────────────────────────────
 * Bands are inclusive integer ranges, and the seeded INR schedule is written in whole rupees:
 * Rs 0 - Rs 199 (0..19900) then Rs 200 - Rs 499 (20000..49900). The 99 paise between two such
 * bands are not a hole anybody made; they are how a person writes a range. So the next band may
 * start up to ONE MAJOR UNIT after the previous one ends (100 minor units for INR and USD, 1 for
 * a currency with no sub-unit) and the schedule still counts as continuous. Anything wider is a
 * hole.
 *
 * ── WHICH BANDS COUNT ─────────────────────────────────────────────────────────────
 * The bands that apply to the deleted band's own place, exactly as pricing picks them
 * (`applicableTiers`). Deleting a state's override is fine when the national schedule still
 * covers the state, and is refused when nothing would.
 */

export interface CoverageBand {
  id: string;
  minMinor: number;
  maxMinor: number | null;
  country: string;
  region: string;
}

/** An uncovered range. `toMinor` null means "and above". Both ends exclusive of covered amounts. */
export interface CoverageGap {
  /** The last covered amount before the gap, or null when the gap starts at 0. */
  afterMinor: number | null;
  /** The first covered amount after it, or null when nothing above is covered. */
  beforeMinor: number | null;
}

/** One major unit in minor units: 100 for INR/USD, 1 for JPY, 1000 for KWD. */
export function majorUnitMinor(currency: string): number {
  try {
    const digits =
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return 10 ** digits;
  } catch {
    return 100;
  }
}

/** The uncovered ranges of [0, infinity) under these bands, ignoring scope. */
export function coverageGaps(
  bands: readonly Pick<CoverageBand, 'minMinor' | 'maxMinor'>[],
  currency: string,
): CoverageGap[] {
  if (bands.length === 0) return [{ afterMinor: null, beforeMinor: null }];
  const step = majorUnitMinor(currency);
  const sorted = [...bands].sort((a, b) => a.minMinor - b.minMinor);
  const gaps: CoverageGap[] = [];
  if (sorted[0].minMinor > 0) gaps.push({ afterMinor: null, beforeMinor: sorted[0].minMinor });
  let reach = sorted[0].maxMinor ?? Number.POSITIVE_INFINITY;
  for (const band of sorted.slice(1)) {
    if (reach === Number.POSITIVE_INFINITY) break;
    if (band.minMinor - reach > step) gaps.push({ afterMinor: reach, beforeMinor: band.minMinor });
    reach = Math.max(reach, band.maxMinor ?? Number.POSITIVE_INFINITY);
  }
  if (reach !== Number.POSITIVE_INFINITY) gaps.push({ afterMinor: reach, beforeMinor: null });
  return gaps;
}

/** What deleting a band would do to the schedule that prices its place. */
export type DeletionImpact =
  | { ok: true }
  | { ok: false; reason: 'NO_BAND_LEFT' }
  | { ok: false; reason: 'GAP'; gaps: CoverageGap[] };

/**
 * Judge deleting `target` from the ACTIVE bands of its currency (`active` may include it).
 *
 * An inactive target prices nothing, so removing it changes nothing and is always allowed.
 */
export function deletionImpact(
  target: CoverageBand & { active: boolean },
  active: readonly CoverageBand[],
  currency: string,
): DeletionImpact {
  return coverageImpact(target, null, active, currency);
}

/**
 * Judge changing `target` into `replacement` - or removing it, when `replacement` is null or
 * inactive - against the ACTIVE bands of its currency (`active` may include the target).
 *
 * ── WHY AN EDIT IS JUDGED LIKE A DELETE (owner decision 2026-10-29) ────────────────
 * Switching a band off, narrowing its range or moving it to another country or state takes
 * coverage away from the place it used to price exactly as a delete does, and fails just as
 * silently at checkout. So every such edit is held to the same rule: refused when the band's
 * place would be left with no band, or with an uncovered range it did not already have.
 *
 * Only the band's OLD place is judged. Wherever the edited band applies now, it adds coverage
 * there and cannot remove any. An inactive target prices nothing today, so an edit to it is
 * always allowed (switching it on only adds coverage, and the overlap check still runs).
 */
export function coverageImpact(
  target: CoverageBand & { active: boolean },
  replacement: (CoverageBand & { active: boolean }) | null,
  active: readonly CoverageBand[],
  currency: string,
): DeletionImpact {
  if (!target.active) return { ok: true };
  const place: FeePlace = {
    country: target.country === '*' ? undefined : target.country,
    region: target.region === '*' ? undefined : target.region,
  };
  const others = active.filter((b) => b.id !== target.id);
  const before = applicableTiers([...others, target], place);
  const after = applicableTiers(
    replacement?.active ? [...others, { ...replacement, id: target.id }] : others,
    place,
  );
  if (after.length === 0) return { ok: false, reason: 'NO_BAND_LEFT' };

  /*
    A gap afterwards is this change's doing unless it lies wholly inside a gap that was
    already there. Comparing ranges, not exact endpoints, matters for edits: widening a band
    next to an existing hole shrinks that hole, and its endpoints move - that is less
    uncovered than before, not a new gap.
  */
  const existing = coverageGaps(before, currency);
  const lo = (g: CoverageGap) => g.afterMinor ?? Number.NEGATIVE_INFINITY;
  const hi = (g: CoverageGap) => g.beforeMinor ?? Number.POSITIVE_INFINITY;
  const created = coverageGaps(after, currency).filter(
    (g) => !existing.some((e) => lo(e) <= lo(g) && hi(g) <= hi(e)),
  );
  return created.length > 0 ? { ok: false, reason: 'GAP', gaps: created } : { ok: true };
}
