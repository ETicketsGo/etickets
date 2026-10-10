import type { PillTone } from '@eticketsgo/web-kit';

/**
 * The words and colours for the states of a booking, a payment, a refund, a payout and a
 * settlement - in one place, so the same state reads the same on every money screen.
 *
 * ── WHY NOT `StatusBadge` ──────────────────────────────────────────────────────────
 * `StatusBadge` spells the enum out ("PARTIALLY REFUNDED", "TRANSFER PROCESSING") and gives one
 * colour per word across every entity, so a REFUNDED booking was painted as an error - the same
 * red as a failed charge - when a refund is a normal end of a sale. The finance queues are read
 * by people deciding what to do next, and the colour is meant to say "needs you" (amber),
 * "went wrong" (red), "done" (green) or "moving" (blue), per entity.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────
 * It only names states the API already returns. It decides nothing about what an operator may do
 * with a row - those rules stay where they were, keyed on the raw status.
 */
export type MoneyEntity = 'booking' | 'payment' | 'refund' | 'payout' | 'settlement';

type Vocabulary = Record<string, { label: string; tone: PillTone }>;

const VOCABULARY: Record<MoneyEntity, Vocabulary> = {
  booking: {
    PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warning' },
    CONFIRMED: { label: 'Confirmed', tone: 'success' },
    PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'warning' },
    REFUNDED: { label: 'Refunded', tone: 'info' },
    CANCELLED: { label: 'Cancelled', tone: 'error' },
    EXPIRED: { label: 'Expired', tone: 'neutral' },
    DISPUTED: { label: 'Disputed', tone: 'error' },
  },
  payment: {
    REQUIRES_PAYMENT: { label: 'Not paid yet', tone: 'neutral' },
    PROCESSING: { label: 'Processing', tone: 'info' },
    AUTHORIZED: { label: 'Authorized', tone: 'info' },
    SUCCEEDED: { label: 'Paid', tone: 'success' },
    FAILED: { label: 'Failed', tone: 'error' },
    VOIDED: { label: 'Voided', tone: 'neutral' },
    REFUNDED: { label: 'Refunded', tone: 'info' },
    PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'warning' },
  },
  refund: {
    REQUESTED: { label: 'Waiting for a decision', tone: 'warning' },
    APPROVED: { label: 'Approved', tone: 'info' },
    REJECTED: { label: 'Rejected', tone: 'neutral' },
    PROCESSING: { label: 'Processing', tone: 'info' },
    COMPLETED: { label: 'Refunded', tone: 'success' },
    FAILED: { label: 'Failed', tone: 'error' },
  },
  payout: {
    PENDING: { label: 'Pending', tone: 'warning' },
    SCHEDULED: { label: 'Scheduled', tone: 'info' },
    PAID: { label: 'Paid', tone: 'success' },
    FAILED: { label: 'Failed', tone: 'error' },
  },
  settlement: {
    PENDING: { label: 'Pending', tone: 'neutral' },
    HELD: { label: 'Held', tone: 'warning' },
    ELIGIBLE: { label: 'Eligible', tone: 'info' },
    APPROVED: { label: 'Approved', tone: 'info' },
    TRANSFER_PROCESSING: { label: 'Transfer in progress', tone: 'info' },
    TRANSFERRED: { label: 'Transferred', tone: 'success' },
    PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'warning' },
    BLOCKED: { label: 'Blocked', tone: 'error' },
    FAILED: { label: 'Failed', tone: 'error' },
    REVERSED: { label: 'Reversed', tone: 'error' },
  },
};

/** "TRANSFER_PROCESSING" -> "Transfer processing", for a state added after this file. */
function words(value: string): string {
  const w = value.toLowerCase().split('_').filter(Boolean);
  if (w.length === 0) return value;
  return [w[0][0].toUpperCase() + w[0].slice(1), ...w.slice(1)].join(' ');
}

/** The plain-English name of a state. A state this file does not know yet still reads as words. */
export function moneyStatusLabel(entity: MoneyEntity, status: string): string {
  return VOCABULARY[entity][status]?.label ?? words(status);
}

export function moneyStatusTone(entity: MoneyEntity, status: string): PillTone {
  return VOCABULARY[entity][status]?.tone ?? 'neutral';
}

/** A filter's options in the same words as the pills in the list under it. */
export function moneyStatusOptions(
  entity: MoneyEntity,
  statuses: readonly string[],
): { value: string; label: string }[] {
  return statuses.map((s) => ({ value: s, label: moneyStatusLabel(entity, s) }));
}
