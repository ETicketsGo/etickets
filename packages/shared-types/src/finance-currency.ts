/**
 * Folding currency case where the two money systems meet.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * This platform stores the same currency two ways, on purpose. `Settlement` and `Dispute` hold
 * lowercase (`settlement.service.ts` forces `.toLowerCase()`, and its `DEFAULT_CURRENCY` is
 * `'usd'`) because that is what the card providers use. Everything else - Booking, Payment,
 * Payout, Receipt, TicketType - holds uppercase, and `events.service.ts` has a `DEFAULT_CURRENCY`
 * of `'INR'`. Two constants, the same name, opposite case.
 *
 * Nothing is broken by that today, because no query spans both. It breaks the first time one
 * does: a `groupBy` over the two would report `INR` and `inr` as different currencies and split
 * an organizer's money in half, and `MARKETS.find((m) => m.currency === currency)` - which is
 * uppercase-only - returns `undefined` for a settlement-sourced `inr`, so the row loses its
 * country.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────
 * Not a migration, and not for writes. Stored values stay exactly as they are: the providers
 * require lowercase, and rewriting history would destroy the traceability that lets anybody check
 * a figure against the row it came from. This folds case at the moment of READING, and nowhere
 * else.
 *
 * There are 37 ad-hoc `.toUpperCase()` calls on currency across the API today. This is one place
 * to mean it, so the next person does not have to notice.
 */

/** A rule that applies to any currency. Used by FeeRule, TaxRule, PaymentRoute. */
export const CURRENCY_WILDCARD = '*';

/**
 * One currency code, folded for comparison and grouping.
 *
 * Returns null when there is nothing to compare: a missing value, or a blank one. Null rather
 * than a default, because guessing a currency for a row that does not state one is how money
 * ends up filed under the wrong heading.
 */
export function readCurrency(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // The wildcard is a rule's scope, not a currency. It must survive unchanged.
  if (trimmed === CURRENCY_WILDCARD) return CURRENCY_WILDCARD;
  return trimmed.toUpperCase();
}

/**
 * Whether two stored currency values mean the same currency.
 *
 * The wildcard matches nothing here on purpose. "Applies to any currency" is a property of a
 * RULE, and answering it is the routing layer's job; letting it match inside a money comparison
 * would quietly make an INR total equal a USD one.
 */
export function sameCurrency(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = readCurrency(a);
  const right = readCurrency(b);
  if (left === null || right === null) return false;
  if (left === CURRENCY_WILDCARD || right === CURRENCY_WILDCARD) return false;
  return left === right;
}

/**
 * Group rows by the currency they are in, folding case.
 *
 * Rows that name no currency are dropped rather than collected under a heading of their own: a
 * money figure with no currency cannot be displayed or added to anything, and inventing a bucket
 * for it only moves the problem into the reader's head.
 */
export function groupByCurrency<T>(
  rows: readonly T[],
  currencyOf: (row: T) => string | null | undefined,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const code = readCurrency(currencyOf(row));
    if (code === null || code === CURRENCY_WILDCARD) continue;
    const bucket = out.get(code);
    if (bucket) bucket.push(row);
    else out.set(code, [row]);
  }
  return out;
}
