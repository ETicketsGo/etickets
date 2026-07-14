/**
 * Pure payment routing policy (ADR-020). Given the editable route rows for an
 * environment and a (country, currency, method) query, pick the primary provider
 * and its optional failover. No DB, no provider knowledge — fully unit-testable.
 *
 * Matching rules:
 *  - A field matches when the row's value is '*' (wildcard) or equals the query
 *    value (case-insensitive). An unspecified query method is treated as '*', so
 *    it only matches method-agnostic rows.
 *  - The most SPECIFIC matching row wins: exact country beats currency beats
 *    method (weighted 4/2/1). Ties are broken by lower `priority`, then stable
 *    order, so selection is deterministic.
 */

export interface RouteRow {
  country: string; // ISO-3166 alpha-2 or '*'
  currency: string; // ISO-4217 or '*'
  method: string; // PaymentMethod or '*'
  provider: string;
  failoverProvider?: string | null;
  priority: number;
}

export interface RouteQuery {
  country?: string;
  currency: string;
  method?: string;
}

export interface RouteDecision {
  provider: string;
  failoverProvider?: string;
}

const WILDCARD = '*';

function norm(value: string | undefined): string {
  return (value ?? WILDCARD).toUpperCase();
}

/** True if `rowValue` ('*' or literal) matches the queried value. */
function fieldMatches(rowValue: string, queryValue: string): boolean {
  return rowValue === WILDCARD || rowValue.toUpperCase() === queryValue;
}

/** Specificity weight: exact matches score, wildcards do not. */
function specificity(
  row: RouteRow,
  q: { country: string; currency: string; method: string },
): number {
  let score = 0;
  if (row.country !== WILDCARD) score += 4;
  if (row.currency !== WILDCARD) score += 2;
  if (row.method !== WILDCARD) score += 1;
  void q;
  return score;
}

/**
 * Select the best matching route for the query, or null when nothing matches.
 * Callers treat null as "no route configured" and fail closed.
 */
export function selectRoute(rows: readonly RouteRow[], query: RouteQuery): RouteDecision | null {
  const q = {
    country: norm(query.country),
    currency: query.currency.toUpperCase(),
    method: norm(query.method),
  };

  let best: RouteRow | null = null;
  let bestScore = -1;
  for (const row of rows) {
    if (
      !fieldMatches(row.country, q.country) ||
      !fieldMatches(row.currency, q.currency) ||
      !fieldMatches(row.method, q.method)
    ) {
      continue;
    }
    const score = specificity(row, q);
    // Higher specificity wins; on a tie the lower priority number wins.
    if (
      score > bestScore ||
      (score === bestScore && best !== null && row.priority < best.priority)
    ) {
      best = row;
      bestScore = score;
    }
  }

  if (!best) return null;
  return {
    provider: best.provider,
    failoverProvider: best.failoverProvider ?? undefined,
  };
}

export interface MerchantRow {
  label: string;
  country?: string | null; // null = any
  currency?: string | null; // null = any
  merchantIdRef?: string | null;
  active: boolean;
}

/**
 * Pick the most specific active merchant account for a (country, currency). Exact
 * country+currency beats country-only beats currency-only beats a catch-all (both
 * null). A row whose country/currency is set but mismatches the query is excluded.
 * Returns null when no active account matches.
 */
export function selectMerchant(
  rows: readonly MerchantRow[],
  country: string | undefined,
  currency: string,
): MerchantRow | null {
  const c = norm(country);
  const cur = currency.toUpperCase();
  let best: MerchantRow | null = null;
  let bestScore = -1;
  for (const row of rows) {
    if (!row.active) continue;
    const rowCountry = row.country ? row.country.toUpperCase() : WILDCARD;
    const rowCurrency = row.currency ? row.currency.toUpperCase() : WILDCARD;
    if (rowCountry !== WILDCARD && rowCountry !== c) continue;
    if (rowCurrency !== WILDCARD && rowCurrency !== cur) continue;
    const score = (rowCountry !== WILDCARD ? 2 : 0) + (rowCurrency !== WILDCARD ? 1 : 0);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}
