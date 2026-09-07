/**
 * Visitor locale helpers — used to order content by relevance to where someone is.
 *
 * Deliberately derived from the BROWSER LOCALE, not an IP geolocation service. That is a
 * trade: locale is less precise than IP (a US-English browser in Toronto reports US), but it
 * needs no third-party lookup, no request-time network call, no per-request cost, and it
 * leaks nothing about the visitor to anyone. For "which cities should we suggest first" that
 * accuracy is sufficient. If the product later needs true geolocation — tax, licensing,
 * regional availability — that is a different mechanism with different privacy obligations,
 * and it should not be bolted onto this.
 *
 * Everything here is a hint for ORDERING and DEFAULTS. Nothing may gate access or change a
 * price on the strength of it: a hint that is wrong should be a mild inconvenience, never a
 * wrong charge.
 */

import { MARKETS } from '@eticketsgo/shared-types';

/**
 * Every IANA zone the platform's markets keep time in, mapped back to its country.
 *
 * Built from `MARKETS`, which already lists the zones a venue in each country could be in,
 * rather than from a second list that would start agreeing and end up disagreeing.
 */
const ZONE_TO_COUNTRY: Record<string, string> = Object.fromEntries(
  MARKETS.flatMap((m) => m.timezones.map((zone) => [zone, m.code])),
);

/**
 * The visitor's country from their TIME ZONE, or null.
 *
 * ── WHY THE ZONE BEATS THE LANGUAGE ────────────────────────────────────────────────
 * `navigator.language` carries a region only when the visitor's browser happens to be
 * configured with one. Plenty report a bare `en`, and on those the country hint was simply
 * null — so discovery could not scope to a country at all and fell back to offering cities
 * from everywhere. A visitor in the United States was shown Bengaluru, Hyderabad and Mumbai,
 * which reads as a broken control rather than as a missing signal.
 *
 * A time zone is always present, is set by the operating system rather than by a language
 * preference, and `America/Chicago` says considerably more about where somebody is than
 * `en` does. It is still only a hint, and it is still local to the browser: nothing is
 * looked up, and nothing about the visitor leaves the page.
 *
 * ── WHY IT IS RESTRICTED TO MARKETS WE SELL IN ─────────────────────────────────────
 * An unrecognised zone returns null rather than a country, which lets the caller fall
 * through to its next signal. Guessing a country we do not operate in would scope the
 * storefront to nothing, and an empty storefront reads as a dead company rather than as a
 * wrong guess.
 */
export function visitorCountryFromTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? (ZONE_TO_COUNTRY[zone] ?? null) : null;
  } catch {
    // No Intl, or a runtime that will not resolve a zone. The caller has other signals.
    return null;
  }
}

/**
 * The visitor's likely country as an ISO-3166 alpha-2 code, or null when it cannot be
 * determined (server render, an exotic locale, an environment without Intl).
 *
 * The time zone is consulted FIRST. It is the stronger of the two signals and the one that
 * is actually present: a browser reporting a bare `en` yields nothing from the locale, and
 * that is the case where a country hint is most needed and was least available.
 */
export function visitorCountry(): string | null {
  const byZone = visitorCountryFromTimeZone();
  if (byZone) return byZone;
  if (typeof navigator === 'undefined') return null;
  const tags = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter(Boolean) as string[];

  for (const tag of tags) {
    // Prefer Intl's parser; it understands the full BCP-47 shape (e.g. "zh-Hant-HK").
    try {
      const region = new Intl.Locale(tag).region;
      if (region) return region.toUpperCase();
    } catch {
      /* fall through to the simple split below */
    }
    const parts = tag.split('-');
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^[A-Za-z]{2}$/.test(last)) return last.toUpperCase();
  }
  return null;
}

/**
 * The currency the visitor most likely thinks in, or null when unknown.
 *
 * IMPORTANT — this is for PRESENTATION ONLY (a "prices shown in…" hint, sorting, an empty
 * state). It must never be used to price or charge anything. Every event is priced by its
 * organiser in one currency, and the checkout charges that currency; converting a display
 * price without a rate source would show a number nobody will actually be charged, and the
 * platform has no FX rate source. Show the event's own currency at the point of purchase.
 */
export function visitorCurrency(): string | null {
  const country = visitorCountry();
  if (!country) return null;
  return COUNTRY_CURRENCY[country] ?? null;
}

/**
 * Countries the platform has fee bands configured for, plus the largest markets a visitor is
 * likely to arrive from. Intentionally small: an incomplete map returns null, and null means
 * "no hint", which is a safe answer. A wrong guess would be worse than none.
 */
const COUNTRY_CURRENCY: Record<string, string> = {
  IN: 'INR',
  US: 'USD',
  CA: 'CAD',
  AU: 'AUD',
  GB: 'GBP',
  NZ: 'NZD',
  SG: 'SGD',
  AE: 'AED',
};
