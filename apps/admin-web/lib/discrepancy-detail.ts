import { money } from '@eticketsgo/web-kit';
import { moneyStatusLabel } from './money-status';

/**
 * A reconciliation discrepancy's free-text detail, said the way a finance person reads it.
 *
 * The detector files the sentence with raw minor units and quoted enum names ("internal 165036
 * vs provider 0", "Provider status is 'CANCELLED' but internal is SUCCEEDED"), next to a column
 * that shows the same amount as "Rs 1,650.36". Two spellings of one number on one row invite a
 * misreading of exactly the figure being reconciled. The stored sentence is evidence and is not
 * rewritten (reconciliation records are never corrected automatically); this is a display
 * translation, and the screen keeps the stored text in the row's title.
 *
 * A sentence this does not recognise comes back unchanged: a new detector is legible on the day
 * it ships. An amount with no known currency is left as the stored text too, because formatting
 * it in a guessed currency would be a wrong amount in a right-looking symbol.
 */
export function describeDiscrepancy(
  detail: string | null,
  currency: string | null | undefined,
): string {
  if (detail === null) return '';
  const cur = currency?.trim().toUpperCase() || null;

  const amount = detail.match(/^Amount differs: internal (-?\d+) vs provider (-?\d+)\.$/);
  if (amount && cur) {
    return `Our records say ${money(Number(amount[1]), cur)}, but the provider says ${money(Number(amount[2]), cur)}.`;
  }

  const currencies = detail.match(
    /^Currency differs: internal ([A-Za-z]{3}) vs provider ([A-Za-z]{3})\.$/,
  );
  if (currencies) {
    return `We took this payment in ${currencies[1].toUpperCase()}, but the provider recorded ${currencies[2].toUpperCase()}.`;
  }

  const status = detail.match(/^Provider status is '([^']+)' but internal is ([A-Z_]+)\.$/);
  if (status) {
    return `The provider shows this payment as ${providerStatusWords(status[1])}, but we have it as ${moneyStatusLabel('payment', status[2]).toLowerCase()}.`;
  }

  const refund = detail.match(/^Refund (-?\d+) exceeds captured (-?\d+)\.$/);
  if (refund && cur) {
    return `This refund (${money(Number(refund[1]), cur)}) is more than the amount collected (${money(Number(refund[2]), cur)}).`;
  }

  const missing = detail.match(/^Payment (.+) is ([A-Z_]+) internally but not found at (.+)\.$/);
  if (missing) {
    return `We have payment ${missing[1]} as ${moneyStatusLabel('payment', missing[2]).toLowerCase()}, but ${missing[3]} has no record of it.`;
  }

  return detail;
}

/** A provider's own status word ("CANCELLED", "captured"), as lower-case words. */
function providerStatusWords(status: string): string {
  return status.replace(/[_-]+/g, ' ').trim().toLowerCase();
}
