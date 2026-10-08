/**
 * How big a room may be before it has to be drawn in blocks.
 *
 * -- WHY A LIMIT EXISTS AT ALL -------------------------------------------------------------
 * The buyer read is two-step for a SECTIONED layout - an overview of blocks, then the seats
 * of ONE block - and single-step for a GRID one, which returns every seat. That is right for
 * a cinema, where the whole room is 400 seats, and it is how cinemas have always worked here.
 *
 * Measured on a real database (`scripts/measure-seating-scale.mjs`):
 *
 *     seats    whole-map read
 *       500      17 ms /    73 KB
 *    10,000     382 ms / 1,467 KB
 *    25,000     854 ms / 3,667 KB
 *
 * A sectioned read of the same 25,000-seat arena is 3 ms / 4 KB for the overview and about
 * 90 ms / 87 KB for one block - flat, because a block is 500 seats whatever the venue holds.
 *
 * So nothing is wrong with GRID; what is wrong is GRID at arena size. A 3.6 MB seat map is
 * not slow in a way a server notices - it is slow on a phone, on the buyer's data, at the
 * moment they are trying to pay. Nothing stopped a 25,000-seat room being created that way.
 *
 * -- WHY 2,000 -----------------------------------------------------------------------------
 * Comfortably above any cinema, including the largest single screens in the world, so no
 * existing cinema can hit it. Around 300 KB on the whole-map read at that size, which is
 * large but not a cliff. It is a deliberate round number rather than a derived one: the
 * measurements show a slope, not a knee, so any threshold is a judgement about what is
 * acceptable to send to a phone.
 */
export const GRID_LAYOUT_MAX_SEATS = 2_000;

export interface GridLimitVerdict {
  ok: boolean;
  /** Present only when refused, and written for the organizer rather than for a log. */
  reason?: string;
}

/**
 * Whether a layout of this kind and size may be published.
 *
 * A pure function so the rule can be tested without a database, and so the number lives in
 * one place rather than being repeated at each call site.
 */
export function checkGridLayoutLimit(
  layoutKind: string | null | undefined,
  seatCount: number,
): GridLimitVerdict {
  // Sectioned layouts are already read a block at a time, so size is not the question.
  if (layoutKind !== 'GRID') return { ok: true };
  if (seatCount <= GRID_LAYOUT_MAX_SEATS) return { ok: true };
  return {
    ok: false,
    reason:
      `A room this size has to be drawn in blocks. ${seatCount.toLocaleString()} seats in one ` +
      `grid would send every seat to every buyer at once, which is slow on a phone. Use a ` +
      `sectioned layout - stands, tiers or blocks - and buyers will pick a block first.`,
  };
}
