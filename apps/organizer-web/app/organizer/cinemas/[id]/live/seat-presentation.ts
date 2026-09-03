import type { LiveSeat, OccupancySnapshot, SeatOverrideKind } from '@eticketsgo/web-kit';
import { money } from '@eticketsgo/web-kit';

/**
 * Presentation rules for live theater operations.
 *
 * Pure functions, no React, so they can be tested without a browser — the same split the
 * scheduling workspace uses. Nothing here recomputes a server decision: occupancy comes from
 * the API already calculated, and seat state is rendered exactly as the API reports it.
 */

export type SeatTone = 'available' | 'held' | 'sold' | 'blocked' | 'gap';

/** Mirrors web-kit's BadgeTone. There is no 'danger'; the error tone is called 'error'. */
export type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

/**
 * One vocabulary for override kinds, taken from the server's own labels.
 *
 * Duplicated here only because the seat map needs a short form that fits in a legend. The
 * KEYS must stay in step with `SeatOverrideKind`; TypeScript enforces that via Record.
 */
export const OVERRIDE_LABEL: Record<SeatOverrideKind, string> = {
  MANUAL_BLOCK: 'Blocked',
  MAINTENANCE: 'Maintenance',
  HOUSE: 'House seat',
  VIP: 'VIP reserved',
  COMPANION: 'Companion hold',
  EMERGENCY: 'Emergency block',
};

export const OVERRIDE_TONE: Record<SeatOverrideKind, Tone> = {
  MANUAL_BLOCK: 'neutral',
  MAINTENANCE: 'warning',
  HOUSE: 'info',
  VIP: 'info',
  COMPANION: 'info',
  EMERGENCY: 'error',
};

/** Every kind an operator may apply, in the order the dialog offers them. */
export const OVERRIDE_KINDS: SeatOverrideKind[] = [
  'MANUAL_BLOCK',
  'MAINTENANCE',
  'HOUSE',
  'VIP',
  'COMPANION',
  'EMERGENCY',
];

export const HOUSE_PURPOSES = [
  { value: 'COMPLIMENTARY', label: 'Complimentary' },
  { value: 'PRESS', label: 'Press / media' },
  { value: 'SPONSOR', label: 'Sponsor' },
  { value: 'MANAGEMENT', label: 'Management' },
  { value: 'TECHNICAL', label: 'Technical' },
] as const;

/**
 * How a seat should be drawn.
 *
 * Derived only from what the server said. A GAP is an aisle spacer with no inventory, and it
 * must not be drawn as an empty sellable seat or an operator will try to block the aisle.
 */
export function seatTone(seat: LiveSeat): SeatTone {
  if (seat.kind === 'GAP') return 'gap';
  switch (seat.status) {
    case 'SOLD':
      return 'sold';
    case 'HELD':
      // An expired hold whose sweeper has not run still reads HELD. Drawing it as a live
      // checkout would tell the operator a seat is busy when it is actually free.
      return seat.heldNow ? 'held' : 'available';
    case 'BLOCKED':
      return 'blocked';
    default:
      return 'available';
  }
}

/**
 * What may be done to this seat, from the server's own rules.
 *
 * Hiding a control is a courtesy, not the control — the API refuses independently. But
 * offering "Block" on a sold seat invites an operator to try something that can only ever
 * fail, so the affordance matches the rule.
 */
export function seatActions(seat: LiveSeat): { block: boolean; release: boolean } {
  if (seat.kind === 'GAP') return { block: false, release: false };
  // Never actionable: somebody holds a ticket. See SEAT-OVERRIDES.md.
  if (seat.status === 'SOLD') return { block: false, release: false };
  if (seat.status === 'HELD' && seat.heldNow) return { block: false, release: false };
  return { block: true, release: seat.status === 'BLOCKED' };
}

/** The accessible name for a seat button — everything a screen reader needs, once. */
export function seatAccessibleName(seat: LiveSeat): string {
  if (seat.kind === 'GAP') return `Aisle space at position ${seat.colIndex}`;
  const parts = [`Seat ${seat.label}`];

  if (seat.kind === 'WHEELCHAIR') parts.push('wheelchair space');
  else if (seat.kind === 'COMPANION') parts.push('companion seat');

  const tone = seatTone(seat);
  if (tone === 'sold') parts.push('sold');
  else if (tone === 'held') parts.push('held by a customer');
  else if (tone === 'blocked') {
    parts.push(seat.overrideKind ? OVERRIDE_LABEL[seat.overrideKind].toLowerCase() : 'blocked');
    if (seat.overrideReason) parts.push(seat.overrideReason);
  } else parts.push('available');

  return parts.join(', ');
}

/**
 * Turn a server refusal code into a sentence for the operator.
 *
 * The codes are the contract; the prose is not. Matching on message text would break the
 * first time somebody improves the wording server-side.
 */
export function explainOverrideCode(code: string | undefined, fallback?: string): string {
  switch (code) {
    case 'SEAT_SOLD':
      return 'This seat has already been sold and cannot be changed.';
    case 'SEAT_HELD':
      return 'This seat is currently held by a customer. Try again after the hold expires.';
    case 'SEAT_TAKEN_CONCURRENTLY':
      return 'The seat changed while you were editing it. The latest status has been loaded.';
    case 'SEAT_NOT_BLOCKED':
      return 'This seat was no longer blocked by the time the release was applied.';
    case 'EMERGENCY_REQUIRES_FORCE':
      return 'This is an emergency block. Releasing it puts a seat back on sale that was withdrawn for safety — confirm explicitly to proceed.';
    case 'SEAT_NOT_ON_SHOW':
      return 'Those seats do not belong to this show.';
    default:
      return fallback ?? 'That change could not be applied.';
  }
}

/**
 * Money for display. Integer minor units in, human string out.
 *
 * Delegated to the one formatter. This hardcoded whole rupees and en-IN, which was right
 * for a ₹250 seat and wrong for anything carrying paise — and it was one of five copies of
 * that decision, which had already drifted into five different answers.
 */
export function formatMoney(minor: number, currency: string): string {
  return money(minor, currency || 'INR');
}

/** Cinema-local wall clock, 24-hour. Never the browser's zone. */
export function formatLocalTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** How stale a snapshot is, in words. A dashboard that cannot say this invites blind trust. */
export function freshness(observedAt: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(observedAt).getTime()) / 1000));
  if (seconds < 20) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

/**
 * Whether a show is worth a duty manager's attention right now.
 *
 * Sorting the board by start time alone buries the show that is about to begin under fifty
 * that already played.
 */
export function isLive(snapshot: OccupancySnapshot, now: Date): boolean {
  return (
    new Date(snapshot.startsAt).getTime() <= now.getTime() &&
    new Date(snapshot.endsAt).getTime() >= now.getTime()
  );
}

/** Occupancy shown as text. Null means nothing was sellable, which is not "0%". */
export function occupancyLabel(percent: number | null): string {
  return percent === null ? '—' : `${percent}%`;
}

/**
 * Tone for an occupancy figure.
 *
 * Deliberately NOT a red/green judgement on the number: a quiet Tuesday matinée is not an
 * error. Only the extremes are called out, because those are the ones that change a decision.
 */
export function occupancyTone(percent: number | null): Tone {
  if (percent === null) return 'neutral';
  if (percent >= 95) return 'success';
  if (percent >= 60) return 'info';
  return 'neutral';
}

/** Expiry, rendered so an operator can see whether it has already lapsed. */
export function describeExpiry(
  expiresAt: string | null,
  now: Date,
  timeZone: string,
): string | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  if (at.getTime() <= now.getTime()) {
    // Lapsed but still blocked: the sweeper runs on a cadence, so a short window is normal.
    return `Expiry passed — returns to sale on the next sweep`;
  }
  return `Returns to sale at ${formatLocalTime(expiresAt, timeZone)}`;
}
