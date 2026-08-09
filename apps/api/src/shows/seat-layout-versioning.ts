/**
 * Seat layout versioning rules.
 *
 * Pure functions on plain data — no Prisma, no Nest — so the decisions can be exhaustively
 * tested without a database, the same way `show-scheduling.ts` and `show-operations.ts` are.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────────────
 * A screen used to have exactly one seat map, and `generateSeatMap` refused once it
 * existed. Safe, and useless: theaters re-seat rooms, convert a row to recliners, add a
 * wheelchair bay. The obvious fix — let operators edit the map — is the dangerous one,
 * because seats are referenced by sold `ShowSeat` rows and issued `Ticket` rows. Editing
 * row A in place silently rewrites what a customer bought last week.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────
 * Layouts are versioned and published versions are IMMUTABLE. A change means cloning to a
 * new DRAFT, editing that, and publishing it. Because a new version owns new `Seat` rows,
 * and every show pins the seats it materialised, history cannot be reached backwards into.
 * Immutability here is structural, not a rule somebody has to remember.
 */

export type LayoutStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface LayoutVersion {
  id: string;
  version: number;
  status: LayoutStatus;
  /** When this version starts applying to newly scheduled shows. */
  effectiveFrom: Date | null;
  publishedAt: Date | null;
  /**
   * Always set by the database, and the last-resort effective instant.
   *
   * `status` defaults to PUBLISHED while the two date columns default to null, so a row
   * written by a seed, a fixture or any caller that does not set them is published with no
   * date. Without this fallback such a screen resolves to "no layout in effect" and becomes
   * unschedulable with an error nobody can act on. Falling back to creation time is also
   * exactly what the migration did for pre-existing maps, so old and new rows behave alike.
   */
  createdAt: Date;
}

export type LayoutOperation = 'EDIT' | 'PUBLISH' | 'ARCHIVE' | 'CLONE' | 'DELETE';

export interface LayoutCommitments {
  /** Shows already pinned to this version that have not yet played. */
  futureShows: number;
  /** Shows pinned to it that have played, or that sold anything. History. */
  historicalShows: number;
  /** Other PUBLISHED versions on the same screen. */
  otherPublishedVersions: number;
}

export interface LayoutVerdict {
  allowed: boolean;
  code: string;
  message: string;
}

const OK: LayoutVerdict = { allowed: true, code: 'OK', message: '' };

/**
 * Which layout version a show starting at `startsAt` must be scheduled against.
 *
 * Only PUBLISHED versions are candidates. DRAFT is invisible to scheduling by definition,
 * and ARCHIVED means "no new shows on this" — existing shows keep working because they hold
 * their own seats, so archiving is a planning decision and never a data deletion.
 *
 * The winner is the latest version already in effect at the show's start. Ordering on
 * `effectiveFrom` rather than on version number is what makes "activate a future version"
 * work: publish v3 dated Monday and tonight's shows still resolve to v2, with no scheduled
 * job and no flag to flip at midnight.
 */
export function resolveEffectiveLayout(
  versions: LayoutVersion[],
  startsAt: Date,
): LayoutVersion | null {
  const candidates = versions.filter(
    (v) => v.status === 'PUBLISHED' && effectiveInstant(v) <= startsAt.getTime(),
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, v) => {
    const a = effectiveInstant(v);
    const b = effectiveInstant(best);
    if (a !== b) return a > b ? v : best;
    // Two versions effective at the same instant is an operator mistake, not a data error.
    // The higher version number is the later intent, so it wins rather than the comparison
    // being left to whatever order the database happened to return.
    return v.version > best.version ? v : best;
  });
}

function effectiveInstant(v: LayoutVersion): number {
  return (v.effectiveFrom ?? v.publishedAt ?? v.createdAt).getTime();
}

/**
 * Whether an operation on a layout version is allowed.
 *
 * Mirrors `evaluateOperation` in show-operations.ts deliberately: same shape, same style of
 * refusal code, so the two policy modules read alike.
 */
export function evaluateLayoutOperation(
  layout: LayoutVersion,
  operation: LayoutOperation,
  commitments: LayoutCommitments,
): LayoutVerdict {
  switch (operation) {
    case 'CLONE':
      // Always allowed. Cloning reads; it never touches the source.
      return OK;

    case 'EDIT':
      if (layout.status !== 'DRAFT') {
        return {
          allowed: false,
          code: 'LAYOUT_NOT_DRAFT',
          message:
            'Only a draft layout can be edited. Clone this version to make changes — published layouts are frozen because shows and issued tickets point at their seats.',
        };
      }
      return OK;

    case 'PUBLISH':
      if (layout.status === 'PUBLISHED') {
        return {
          allowed: false,
          code: 'LAYOUT_ALREADY_PUBLISHED',
          message: 'This layout version is already published.',
        };
      }
      if (layout.status === 'ARCHIVED') {
        return {
          allowed: false,
          code: 'LAYOUT_ARCHIVED',
          message: 'An archived layout cannot be republished. Clone it to a new version.',
        };
      }
      return OK;

    case 'ARCHIVE':
      if (layout.status === 'DRAFT') {
        return {
          allowed: false,
          code: 'LAYOUT_NOT_PUBLISHED',
          message: 'A draft has never been used. Delete it instead of archiving it.',
        };
      }
      if (layout.status === 'ARCHIVED') {
        return {
          allowed: false,
          code: 'LAYOUT_ALREADY_ARCHIVED',
          message: 'This layout version is already archived.',
        };
      }
      if (commitments.futureShows > 0) {
        // Archiving would not break those shows — they hold their own seats — but it would
        // leave the schedule showing a layout nobody can find in the active list, and the
        // operator almost certainly meant to move them first.
        return {
          allowed: false,
          code: 'LAYOUT_HAS_FUTURE_SHOWS',
          message: `${commitments.futureShows} scheduled show${
            commitments.futureShows === 1 ? '' : 's'
          } still use this layout. Reschedule or cancel them before archiving it.`,
        };
      }
      if (commitments.otherPublishedVersions === 0) {
        return {
          allowed: false,
          code: 'LAYOUT_LAST_PUBLISHED',
          message:
            'This is the only published layout for the screen. Publish a replacement before archiving it, or the screen cannot be scheduled.',
        };
      }
      return OK;

    case 'DELETE':
      if (layout.status !== 'DRAFT') {
        return {
          allowed: false,
          code: 'LAYOUT_NOT_DRAFT',
          message:
            'Only a draft can be deleted. Published layouts are permanent records of how a room was laid out when tickets were sold; archive it instead.',
        };
      }
      return OK;
  }
}

// ── Comparing two versions ────────────────────────────────────────────────────────

/** A seat, reduced to what a human comparison cares about. */
export interface ComparableSeat {
  /** Row label, e.g. "A". */
  row: string;
  /** Seat label within the row, e.g. "12". */
  label: string;
  categoryName: string;
  kind: string;
}

export interface SeatChange {
  seat: string;
  from?: { categoryName: string; kind: string };
  to?: { categoryName: string; kind: string };
}

export interface LayoutComparison {
  addedSeats: SeatChange[];
  removedSeats: SeatChange[];
  changedSeats: SeatChange[];
  unchangedCount: number;
  /** Net capacity delta, counting only real seats — gaps are not sellable. */
  capacityDelta: number;
}

/**
 * Diff two layout versions by seat identity.
 *
 * Seats are matched on `row + label` ("A12"), NOT on database id, because a clone produces
 * entirely new `Seat` rows — matching on id would report every seat as removed-and-added
 * and tell the operator nothing. What they want to know is "what changed about A12".
 */
export function compareLayouts(
  before: ComparableSeat[],
  after: ComparableSeat[],
): LayoutComparison {
  const key = (s: ComparableSeat) => `${s.row}${s.label}`;
  const beforeByKey = new Map(before.map((s) => [key(s), s]));
  const afterByKey = new Map(after.map((s) => [key(s), s]));

  const added: SeatChange[] = [];
  const removed: SeatChange[] = [];
  const changed: SeatChange[] = [];
  let unchanged = 0;

  for (const [k, a] of afterByKey) {
    const b = beforeByKey.get(k);
    if (!b) {
      added.push({ seat: k, to: { categoryName: a.categoryName, kind: a.kind } });
      continue;
    }
    if (b.categoryName !== a.categoryName || b.kind !== a.kind) {
      changed.push({
        seat: k,
        from: { categoryName: b.categoryName, kind: b.kind },
        to: { categoryName: a.categoryName, kind: a.kind },
      });
    } else {
      unchanged += 1;
    }
  }
  for (const [k, b] of beforeByKey) {
    if (!afterByKey.has(k)) {
      removed.push({ seat: k, from: { categoryName: b.categoryName, kind: b.kind } });
    }
  }

  const sellable = (seats: ComparableSeat[]) => seats.filter((s) => s.kind !== 'GAP').length;

  const bySeat = (x: SeatChange, y: SeatChange) => x.seat.localeCompare(y.seat);
  return {
    addedSeats: added.sort(bySeat),
    removedSeats: removed.sort(bySeat),
    changedSeats: changed.sort(bySeat),
    unchangedCount: unchanged,
    capacityDelta: sellable(after) - sellable(before),
  };
}

// ── Seat kinds ────────────────────────────────────────────────────────────────────

/** Seat kinds a layout may contain. */
export const SEAT_KINDS = ['SEAT', 'GAP', 'WHEELCHAIR', 'COMPANION'] as const;
export type SeatKind = (typeof SEAT_KINDS)[number];

/**
 * Whether a seat kind can ever be sold.
 *
 * A GAP is an aisle spacer that exists only so the map renders with the right geometry.
 * Wheelchair and companion spaces ARE sellable — restricting who may book them is a booking
 * rule, not a reason to hide them from inventory.
 */
export function isSellableKind(kind: string): boolean {
  return kind !== 'GAP';
}
