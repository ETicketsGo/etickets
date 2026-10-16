import { money, type CurrencyTotal, type EventCancelPreview } from '@eticketsgo/web-kit';

/**
 * The words for what cancelling an event does to money, before and after.
 *
 * Kept out of the dialogs so the sentences are tested: the old dialog said "give it back at the
 * counter" and nothing else, and an organizer could not tell whether that meant one booking or
 * forty, or how much cash to take out of the tin.
 */

/** One amount per currency, joined with "and". Never one figure for two currencies. */
export function totalsText(totals: CurrencyTotal[]): string {
  if (totals.length === 0) return money(0);
  return totals.map((t) => money(t.amountMinor, t.currency)).join(' and ');
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The impact, one plain sentence per kind of booking, in the order an organizer acts on it. */
export function previewLines(p: EventCancelPreview): string[] {
  const lines: string[] = [];
  lines.push(
    p.datesToCancel === 0
      ? 'No dates are still to come, so no date is cancelled.'
      : `${n(p.datesToCancel, 'date', 'dates')} still to come ${p.datesToCancel === 1 ? 'is' : 'are'} cancelled. Dates that already happened stay as they are.`,
  );
  if (p.onlineRefunds.count > 0) {
    lines.push(
      `${n(p.onlineRefunds.count, 'online booking gets', 'online bookings get')} a refund request for the full amount: ${totalsText(p.onlineRefunds.totals)} in total. You approve ${p.onlineRefunds.count === 1 ? 'it' : 'them'} on Refunds, and the money goes back the way it was paid.`,
    );
  }
  if (p.alreadyInRefund > 0) {
    lines.push(
      `${n(p.alreadyInRefund, 'online booking already has', 'online bookings already have')} a refund. ${p.alreadyInRefund === 1 ? 'It stays' : 'They stay'} as ${p.alreadyInRefund === 1 ? 'it is' : 'they are'}.`,
    );
  }
  if (p.cash.count > 0) {
    lines.push(
      `${n(p.cash.count, 'booking was', 'bookings were')} paid in cash at the counter: ${totalsText(p.cash.totals)} to give back in cash. ${p.cash.count === 1 ? 'Its tickets stop' : 'Their tickets stop'} working now. Cash is not refunded online.`,
    );
  }
  if (p.free > 0) {
    lines.push(
      `${n(p.free, 'free booking is', 'free bookings are')} cancelled. Nobody paid, so nothing goes back.`,
    );
  }
  if (
    p.onlineRefunds.count === 0 &&
    p.cash.count === 0 &&
    p.alreadyInRefund === 0 &&
    p.free === 0
  ) {
    lines.push('Nobody has booked a date still to come, so there is nothing to refund.');
  }
  return lines;
}
