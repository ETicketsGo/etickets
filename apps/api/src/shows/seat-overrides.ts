/**
 * Show-level seat override rules.
 *
 * Pure policy — no Prisma, no Nest. What an operator may do to one seat of one show, and
 * more importantly what they may not.
 *
 * ── WHY STATUS AND KIND ARE SEPARATE ──────────────────────────────────────────────
 * `ShowSeat.status` answers "can this be sold". Booking's hold is a single conditional
 * statement — `UPDATE … WHERE status = 'AVAILABLE'` — so anything that is not AVAILABLE is
 * unbookable atomically, with no cooperation needed from the booking path.
 *
 * Encoding the REASON in the status (MAINTENANCE, HOUSE, VIP…) would mean every booking
 * query has to enumerate the unbookable states, and would break the moment somebody adds a
 * seventh reason. So there is exactly one operator status, BLOCKED, and a separate
 * `overrideKind` carrying why. Reports, the seat map legend and the audit trail all read
 * the kind; the booking engine never has to.
 */

export const OVERRIDE_KINDS = [
  'MANUAL_BLOCK',
  'MAINTENANCE',
  'HOUSE',
  'VIP',
  'COMPANION',
  'EMERGENCY',
] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

/** The seat states the system recognises. */
export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD' | 'BLOCKED';

export interface SeatState {
  status: SeatStatus;
  overrideKind: OverrideKind | null;
  /** Set while a customer has the seat in a checkout that has not expired. */
  holdExpiresAt: Date | null;
  holdBookingId: string | null;
}

export type SeatAction = 'BLOCK' | 'RELEASE';

export interface OverrideVerdict {
  allowed: boolean;
  code: string;
  message: string;
}

const OK: OverrideVerdict = { allowed: true, code: 'OK', message: '' };

/**
 * House-seat sub-reasons, for reporting.
 *
 * These are deliberately NOT separate override kinds. A comp for a sponsor and a comp for a
 * journalist are the same operational act — the house withheld a seat — and finance wants
 * them on one line with a breakdown, not scattered across six enum members that every
 * consumer has to learn.
 */
export const HOUSE_PURPOSES = [
  'COMPLIMENTARY',
  'PRESS',
  'SPONSOR',
  'MANAGEMENT',
  'TECHNICAL',
] as const;
export type HousePurpose = (typeof HOUSE_PURPOSES)[number];

/**
 * Can this seat be overridden right now, and if not, why not.
 *
 * ── WHAT IS NEVER OVERRIDABLE ─────────────────────────────────────────────────────
 * SOLD. Somebody holds a ticket. Blocking their seat does not un-sell it — it produces a
 * customer at the door with a valid ticket for a seat the system says is broken. The only
 * honest routes are cancelling the show or refunding that booking, both of which tell the
 * customer something. This refusal is the single most important rule in the file.
 *
 * ── HELD IS A POLICY DECISION, NOT AN OVERSIGHT ───────────────────────────────────
 * A held seat is somebody mid-checkout who may already have been charged by the provider.
 * Stealing it risks taking money for a seat we then blocked. So a live hold is refused and
 * the operator is told when it expires — the wait is bounded and short.
 *
 * An EXPIRED hold is different: the checkout is dead, the sweeper simply has not run yet.
 * Treating that as blocking would make overrides randomly fail for up to a sweep interval
 * with an explanation the operator cannot act on.
 */
export function evaluateSeatOverride(
  seat: SeatState,
  action: SeatAction,
  now: Date,
): OverrideVerdict {
  if (action === 'BLOCK') {
    if (seat.status === 'SOLD') {
      return {
        allowed: false,
        code: 'SEAT_SOLD',
        message:
          'This seat is sold. Blocking it would leave a customer holding a valid ticket for a seat the system says is unusable — cancel the show or refund the booking instead.',
      };
    }
    if (seat.status === 'HELD' && isHoldLive(seat, now)) {
      return {
        allowed: false,
        code: 'SEAT_HELD',
        message: `A customer is checking out with this seat${expiryPhrase(
          seat.holdExpiresAt,
          now,
        )}. Blocking it now risks taking their money for a seat we have withdrawn.`,
      };
    }
    return OK;
  }

  // RELEASE
  if (seat.status === 'SOLD') {
    return {
      allowed: false,
      code: 'SEAT_SOLD',
      message: 'This seat is sold. There is nothing to release.',
    };
  }
  if (seat.status === 'HELD' && isHoldLive(seat, now)) {
    return {
      allowed: false,
      code: 'SEAT_HELD',
      message: 'A customer is checking out with this seat. It is not blocked.',
    };
  }
  if (seat.status !== 'BLOCKED') {
    return {
      allowed: false,
      code: 'SEAT_NOT_BLOCKED',
      message: 'This seat is not blocked, so there is nothing to release.',
    };
  }
  return OK;
}

/** A hold only counts if it exists and has not lapsed. */
export function isHoldLive(seat: Pick<SeatState, 'holdExpiresAt'>, now: Date): boolean {
  return seat.holdExpiresAt !== null && seat.holdExpiresAt.getTime() > now.getTime();
}

function expiryPhrase(expiresAt: Date | null, now: Date): string {
  if (!expiresAt) return '';
  const mins = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 60_000));
  if (mins === 0) return ', expiring now';
  return `, for another ${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * Whether an override of this kind may be undone by the plain "release" action.
 *
 * EMERGENCY is excluded on purpose. A gangway keep-clear or an incident block is a safety
 * decision, and it must not disappear because somebody was clicking through a seat map
 * clearing what looked like clutter. Releasing one is still possible — it just has to be
 * done deliberately, with `force`, which is audited distinctly.
 */
export function isCasuallyReleasable(kind: OverrideKind | null): boolean {
  return kind !== 'EMERGENCY';
}

/**
 * Does a maintenance block need an expiry?
 *
 * Not enforced — some faults genuinely are open-ended until an engineer visits — but a
 * maintenance block with no deadline is the one most likely to be forgotten, and a forgotten
 * block is a seat that silently stops earning. The caller surfaces this as a warning.
 */
export function shouldSuggestExpiry(kind: OverrideKind, expiresAt: Date | null): boolean {
  return kind === 'MAINTENANCE' && expiresAt === null;
}

/** Reason text is mandatory, and whitespace is not a reason. */
export function normaliseReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ── Accessibility ─────────────────────────────────────────────────────────────────

/**
 * Companion seats that should be offered alongside a wheelchair space.
 *
 * A wheelchair user booking alone should not have to argue with a seat map to sit next to
 * the person they came with. This returns the immediate neighbours in the same row so the
 * operator can hold them — it does NOT hold anything itself, because whether to do so is an
 * operational judgement (a sold-out premiere and a quiet Tuesday are different decisions).
 *
 * Neighbours already sold or held are excluded: suggesting them would produce a refusal the
 * operator can do nothing about.
 */
export function companionCandidates(
  seats: { seatId: string; row: string; colIndex: number; kind: string; status: SeatStatus }[],
  wheelchairSeatId: string,
): string[] {
  const target = seats.find((s) => s.seatId === wheelchairSeatId);
  if (!target || target.kind !== 'WHEELCHAIR') return [];

  return seats
    .filter(
      (s) =>
        s.row === target.row &&
        Math.abs(s.colIndex - target.colIndex) === 1 &&
        s.kind !== 'GAP' &&
        s.status === 'AVAILABLE',
    )
    .sort((a, b) => a.colIndex - b.colIndex)
    .map((s) => s.seatId);
}

// ── Presentation ──────────────────────────────────────────────────────────────────

/** Operator-facing label for an override kind. One vocabulary, server-side. */
export const OVERRIDE_LABEL: Record<OverrideKind, string> = {
  MANUAL_BLOCK: 'Blocked',
  MAINTENANCE: 'Maintenance',
  HOUSE: 'House seat',
  VIP: 'VIP reserved',
  COMPANION: 'Companion hold',
  EMERGENCY: 'Emergency block',
};

/**
 * Whether a blocked seat counts against sellable capacity in occupancy reporting.
 *
 * All of them do. A house seat is not sold, and reporting 100% occupancy because the only
 * empty seats were comped would flatter every number finance looks at. Occupancy is measured
 * against seats that were actually available to the public.
 */
export function reducesSellableCapacity(_kind: OverrideKind): boolean {
  return true;
}
