/**
 * The edge headers we trust for a request's country, in the order we trust them. Set by the
 * proxy in front of the API (Cloudflare and friends); see `LocationService.resolve`, which
 * reads the same list.
 */
export const COUNTRY_HEADERS = [
  'cf-ipcountry',
  'x-vercel-ip-country',
  'x-appengine-country',
] as const;

/**
 * The country the network places a request in, by the same trusted edge headers `resolve`
 * reads - or null. Exported so sign-up records the SAME answer the storefront was given
 * (`User.detectedCountry`, source 'network'), rather than a second reading of the headers.
 *
 * Only a well-formed alpha-2 code is returned: "XX" (anonymising proxy) and "T1" (Tor) mean
 * "could not tell", and anything else a header might carry is not a country.
 */
export function networkCountry(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  for (const name of COUNTRY_HEADERS) {
    const raw = headers[name];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    if (!value || value === 'XX' || value === 'T1') continue;
    return /^[A-Z]{2}$/.test(value) ? value : null;
  }
  return null;
}
