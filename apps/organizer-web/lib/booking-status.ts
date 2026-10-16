import type { PillTone } from '@eticketsgo/web-kit';

/**
 * A booking's state in the counter's words, with the colour of what it means for the person at
 * the desk: green can be printed, amber is waiting on the buyer, red did not go through.
 *
 * The same words the admin console uses for a booking (`admin-web/lib/money-status.ts`), so an
 * organizer and the platform's support team on the phone to them say the same thing. A state
 * added after this file still reads as words rather than as an enum.
 */
const BOOKING: Record<string, { label: string; tone: PillTone }> = {
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warning' },
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'warning' },
  REFUNDED: { label: 'Refunded', tone: 'info' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  DISPUTED: { label: 'Disputed', tone: 'error' },
};

export function bookingStatusLabel(status: string): string {
  const known = BOOKING[status]?.label;
  if (known) return known;
  const words = status.toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return status;
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

export function bookingStatusTone(status: string): PillTone {
  return BOOKING[status]?.tone ?? 'neutral';
}

/**
 * The narrowing choices for a set of search results: only values that are actually in it, in a
 * stable order, each with how many rows it would leave. A filter offering "Refunded" over results
 * with none is a control that can only ever empty the list.
 */
export function narrowingOptions<T>(
  rows: T[],
  key: (row: T) => string,
  label: (value: string) => string,
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * How a cash booking was paid, in words, or null for one paid online.
 *
 * A cash booking has no payment row, so the payment column read "-" for a counter sale paid in
 * full. After its show is cancelled, it says whether the cash has gone back yet.
 */
export function cashPaymentLabel(b: {
  paymentMethod?: string;
  status: string;
  cashCollected?: boolean;
  cashReturned?: boolean;
}): string | null {
  if (b.paymentMethod !== 'CASH') return null;
  if (!b.cashCollected)
    return b.status === 'PENDING_PAYMENT' ? 'Cash, to pay at the counter' : 'Cash, not taken';
  if (b.status === 'CANCELLED') return b.cashReturned ? 'Cash given back' : 'Cash to give back';
  return 'Cash at the counter';
}
