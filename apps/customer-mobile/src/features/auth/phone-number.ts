import { MARKETS, type Market } from '@eticketsgo/shared-types';

/**
 * Reading a phone number the way the storefront does (apps/customer-web/lib/phone-number.ts),
 * so a number typed in the app and on the website reaches the same account.
 *
 * The country is ASKED FOR, never assumed. A `+91` default once sent a US visitor's sign-in
 * code to a stranger in India. The field opens on where the person is (the server's guess,
 * then the phone's region) when that is a country we sell in, and otherwise on nothing.
 */

/** The countries we sell in, by name. */
export const PHONE_COUNTRIES: readonly Market[] = [...MARKETS].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** Longest calling code first, in MARKETS order for ties (+1: the US before Canada). */
const BY_LONGEST_CODE = [...MARKETS].sort((a, b) => b.callingCode.length - a.callingCode.length);

const withoutTrunkZero = (digits: string) => digits.replace(/^0+/, '');

export function isPhoneCountry(code: string | null | undefined): code is string {
  return Boolean(code) && PHONE_COUNTRIES.some((c) => c.code === code);
}

/** The first candidate that is a country we sell in, or null to make the person choose. */
export function phoneCountryGuess(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const code = candidate?.toUpperCase();
    if (isPhoneCountry(code)) return code;
  }
  return null;
}

/**
 * What was typed or pasted. A full international number (`+1 415...`, `0091 98...`) names
 * its own country, which then wins over the one chosen. Anything else is the national part.
 */
export function readTypedNumber(
  typed: string,
  current?: string | null,
): { country?: string; national: string } {
  const trimmed = typed.trim();
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
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
