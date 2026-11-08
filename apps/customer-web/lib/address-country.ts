import { isIPv4 } from 'node:net';
import ip3country from 'ip3country';

/**
 * The country of a network address, from IP2Location LITE data (via `ip3country`), or null.
 *
 * Server-only, local and synchronous: no network call, no third party sees the address. The
 * table is IPv4; the storefront has no IPv6 address (no AAAA record), so every visitor reaches
 * the edge over IPv4 and `x-real-ip` is IPv4. An IPv4-mapped IPv6 form is unwrapped; anything
 * else (IPv6, junk, a list, a private or reserved range) is null, and the page simply keeps
 * asking the browser, as it always has.
 *
 * Attribution required by the data's licence (CC BY-SA 4.0) is on the privacy page:
 * "This site or product includes IP2Location LITE data available from
 * https://lite.ip2location.com".
 */
let initialised = false;

export function countryForAddress(address: string | null | undefined): string | null {
  let value = (address ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  if (!isIPv4(value)) return null;
  if (!initialised) {
    ip3country.init();
    initialised = true;
  }
  const code = ip3country.lookupStr(value);
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}
