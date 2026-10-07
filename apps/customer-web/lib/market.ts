import { cookies } from 'next/headers';
import { policyJurisdictionFor, type PolicyJurisdiction } from '@eticketsgo/shared-types';

/** Written by the storefront when the product resolves a market. See `rememberMarketCountry`. */
const MARKET_COOKIE = 'etg_market';

/**
 * The market a server-rendered page should treat the reader as being in.
 *
 * -- WHY THIS EXISTS, AND WHAT IT DELIBERATELY IS NOT -----------------------------------
 * Legal documents must show the version that applies to the customer, and a customer should
 * not have to operate a jurisdiction picker to get it. The first attempt gave every document
 * its own country selector, which put our policy resolver on screen and made the pages read
 * as a compliance console.
 *
 * So the market comes from the product. `etg_market` mirrors the SAME `scopeCountry` the
 * storefront already resolved and already filters every event list by - it is not a second
 * country-selection system, and nothing sets it independently.
 *
 * -- THE ORDER, AND WHY --------------------------------------------------------------------
 * 1. An explicit `?country=` in the URL. This is how the Legal Center links to a specific
 *    market and how somebody shares "the Indian terms" with a colleague. An explicit request
 *    always wins over an inferred context.
 * 2. The product's market cookie.
 * 3. GLOBAL. Never an error, never a guess from an IP address.
 *
 * A first visit, a privacy mode that blocks cookies, or a crawler all land on 3 - which is
 * the text written for everybody, and is correct rather than merely safe.
 */
export async function resolveJurisdiction(
  explicit?: string | string[] | undefined,
): Promise<PolicyJurisdiction> {
  const asked = Array.isArray(explicit) ? explicit[0] : explicit;
  if (asked && asked.trim()) return policyJurisdictionFor(asked);

  try {
    const store = await cookies();
    const value = store.get(MARKET_COOKIE)?.value;
    if (value) return policyJurisdictionFor(decodeURIComponent(value));
  } catch {
    /* no cookie store in this rendering context; the global text is the right answer */
  }
  return 'GLOBAL';
}
