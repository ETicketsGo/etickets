import { MARKETS, type Market } from '@eticketsgo/shared-types';

/**
 * One way to read a phone number a customer types, for every phone field on the storefront.
 *
 * ── WHY THIS IS ONE FILE ───────────────────────────────────────────────────────────
 * Sign-in and sign-up each kept a private copy of the country list and the paste handling,
 * and the profile page kept neither: it took free text and the server refused anything without
 * a `+`, so somebody in the United States typing their own ten digits was told to "start with
 * the country code". Every field now reads a number the same way.
 */

/** The countries we sell in, in the order a person scans a list: by name. */
export const PHONE_COUNTRIES: readonly Market[] = [...MARKETS].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/**
 * Longest calling code first, so a pasted +971 number is not read as +9.
 *
 * From the MARKETS order, not the alphabetical one: +1 is shared by the United States and
 * Canada, and in alphabetical order Canada came first, so every pasted US number switched the
 * select to Canada. The sort is stable, so the platform's own market order breaks the tie.
 */
const BY_LONGEST_CODE = [...MARKETS].sort((a, b) => b.callingCode.length - a.callingCode.length);

/** The domestic trunk `0` is not part of the number once a country code is in front of it. */
const withoutTrunkZero = (digits: string) => digits.replace(/^0+/, '');

export function isPhoneCountry(code: string | null | undefined): code is string {
  return Boolean(code) && PHONE_COUNTRIES.some((c) => c.code === code);
}

/**
 * The country a phone field should open on, or null to make the person choose.
 *
 * WHERE THE VISITOR IS, in the order the storefront's city picker trusts it: the location the
 * platform resolved (the network edge's country, else the device region), then the browser's
 * own time zone and language. Never a hard-coded +91 or +1 - a guessed country is how a code
 * was once sent to a stranger, so an unknown visitor gets an empty select, not a default.
 *
 * A country we do not sell in is skipped rather than returned: the select cannot show it.
 */
export function phoneCountryGuess(
  located: string | null | undefined,
  browser: string | null | undefined,
): string | null {
  for (const candidate of [located, browser]) {
    const code = candidate?.toUpperCase();
    if (isPhoneCountry(code)) return code;
  }
  return null;
}

/**
 * Reads what was typed or pasted into the number box.
 *
 * A full international number (`+1 415...`, `0091 98...`) names its own country, which then
 * wins over whatever the select said. Anything else is the national part.
 */
export function readTypedNumber(
  typed: string,
  current?: string | null,
): { country?: string; national: string } {
  const trimmed = typed.trim();
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
    // A Canadian who pastes +1... keeps Canada: the number cannot say which +1 country it is.
    const kept = MARKETS.find((c) => c.code === current && digits.startsWith(c.callingCode));
    const pasted = kept ?? BY_LONGEST_CODE.find((c) => digits.startsWith(c.callingCode));
    if (pasted) {
      return {
        country: pasted.code,
        national: withoutTrunkZero(digits.slice(pasted.callingCode.length)),
      };
    }
  }
  return { national: withoutTrunkZero(typed.replace(/\D/g, '')) };
}

/** The E.164 number, or '' while either half is missing. */
export function toE164(country: string | null | undefined, national: string): string {
  const market = PHONE_COUNTRIES.find((c) => c.code === country);
  return market && national ? `+${market.callingCode}${national}` : '';
}
