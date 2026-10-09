import { MARKETS, marketFor } from '@eticketsgo/shared-types';

/**
 * Countries on the admin console: how one is named, and how one travels in a link.
 *
 * Stored country values are whatever was typed before the dropdowns existed - "India", "india",
 * "IN", "USA" - so a row is named through `marketFor`, which knows every spelling of a market.
 * A value it does not recognise is still shown, as stored: an unknown country is a fact about the
 * data, and hiding it would make a row look as if it had none.
 */

export interface CountryDisplay {
  /** ISO alpha-2, or null when the stored value is not a market this platform knows. */
  code: string | null;
  /** The market's name, or the stored value as written. */
  name: string;
}

/** A stored country value, named. Null when nothing is stored. */
export function countryDisplay(stored: string | null | undefined): CountryDisplay | null {
  const raw = (stored ?? '').trim();
  if (!raw) return null;
  const market = marketFor(raw);
  return market ? { code: market.code, name: market.name } : { code: null, name: raw };
}

/**
 * The markets a country filter offers, in the order the platform lists them.
 *
 * From `MARKETS`, never typed out per screen: a new market added there appears in every filter
 * at once, and a hand-written list is the one that forgets it.
 */
export function countryFilterOptions(): { code: string; name: string }[] {
  return MARKETS.map((m) => ({ code: m.code, name: m.name }));
}

/**
 * The `country` query parameter, read from a URL.
 *
 * Only a 2-letter code is passed on; anything else is treated as absent rather than sent to the
 * API, which would refuse it with a 400 and empty the list. A hand-edited link should fall back
 * to "every country", not to an error page.
 */
export function parseCountryParam(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : undefined;
}
