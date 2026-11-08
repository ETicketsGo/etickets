/**
 * The visitor's market on a FIRST visit, known to the server before it renders - but only
 * when the server and the browser are certain to get the same answer.
 *
 * ── WHY ONLY FROM AN EDGE HEADER ───────────────────────────────────────────────────
 * On a first visit there is no `etg_market` cookie, so the storefront draws a placeholder and
 * waits for the browser's `location/resolve`. Knowing the market here draws it in the first
 * paint - but a server answer the browser then contradicts is the defect itself: the page draws
 * one market and swaps in another.
 *
 * The browser asks with the device's region (time zone first, then language; see
 * `visitorCountry`). The server cannot see a time zone, and the language alone disagrees often:
 * an `en-US` browser in Asia/Kolkata is common, and the browser rightly says India. So no guess
 * is made from `Accept-Language`, and the client IP is no help either: the API has no IP
 * database, only the edge headers.
 *
 * A trusted edge country header (`cf-ipcountry` and friends, the list the API reads in
 * `discovery/network-country.ts`) is different: the API ranks it above the device region and
 * scopes to it as-is (`LocationService.resolve`, step 2), and the browser's own request through
 * the same edge carries the same header - so both get the same answer. It is read here directly
 * rather than by asking the API: a call from this server would reach the API from the server's
 * address, and an edge in front of the API would stamp the SERVER's country on it.
 *
 * With an edge CITY header the API may map the city to another country, so that case is left
 * to the browser. Railway sets none of these today; then the network address is used instead
 * (see `firstVisitCountry`).
 */
const EDGE_COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-appengine-country'];
const EDGE_CITY_HEADERS = ['cf-ipcity', 'x-vercel-ip-city'];

/** "XX" (anonymising proxy) and "T1" (Tor) mean the edge could not tell. */
function edgeValue(headers: Pick<Headers, 'get'>, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value && value.toUpperCase() !== 'XX' && value.toUpperCase() !== 'T1') return value;
  }
  return null;
}

/**
 * How the address fallback is wired: the lookup, and whether `x-real-ip` can be believed.
 * Only Railway's edge is known to set it (and to overwrite a visitor's own); anywhere else a
 * client could name any address, so the fallback is off.
 */
export interface AddressFallback {
  countryFor: (address: string) => string | null;
  trustRealIp: boolean;
}

/**
 * The scope country to draw a first visit for, or null to keep asking the browser.
 *
 * ── THE ADDRESS FALLBACK (owner decision, 2026-11-08) ──────────────────────────────
 * With no edge header (Railway sets none) the first visit used to be drawn as a placeholder
 * until the browser had worked out its country and fetched the events: on a phone that was
 * 4.9 s (PROD, empty) to 6.0 s (QA, with events) before the main content appeared in
 * Lighthouse. Now the visitor's network address (`x-real-ip`, set by Railway's edge) is
 * looked up in a local country table and the page is drawn for that country.
 *
 * This is a first guess, not an answer: the browser still asks with its own region on every
 * first visit, and where it disagrees (a VPN, a traveller) the page moves to the browser's
 * answer, with its height held so nothing below jumps (`settledLate` in discover-home). For
 * everybody else - the address and the device agree - the first paint is the finished page.
 * A guess only decides what is drawn first; it never gates access or changes a price.
 */
export function firstVisitCountry(
  headers: Pick<Headers, 'get'>,
  fallback?: AddressFallback,
): string | null {
  if (edgeValue(headers, EDGE_CITY_HEADERS)) return null;
  const country = edgeValue(headers, EDGE_COUNTRY_HEADERS)?.toUpperCase();
  if (country) return /^[A-Z]{2}$/.test(country) ? country : null;
  if (!fallback?.trustRealIp) return null;
  const address = headers.get('x-real-ip')?.trim();
  if (!address || address.includes(',')) return null;
  const fromAddress = fallback.countryFor(address)?.toUpperCase() ?? null;
  return fromAddress && /^[A-Z]{2}$/.test(fromAddress) ? fromAddress : null;
}
