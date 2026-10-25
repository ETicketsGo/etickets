import { MARKETS } from './markets';
import { marketsForE164 } from './notification-routing';

/**
 * What a phone number and a verified code tell us about an account - and what they do not.
 *
 * ── ONE RULE FOR THE WEBSITE AND THE APP ───────────────────────────────────────────
 * The API answers `POST /auth/phone/verify` with `isNewAccount`. Both clients used to ignore it,
 * so "Create account" with a number that already had an account looked exactly like a new
 * account being made, every time (owner report, 2026-10-25). The meaning of that answer lives
 * here so the two clients cannot read it differently.
 */

/** What the person should be told after a code was proved. */
export type PhoneSignInOutcome =
  /** Sign-up, and the number was new: the account was just made. */
  | 'created'
  /** Sign-up, but the number already had an account: we signed them into THAT account. */
  | 'existing'
  /** The Sign-in form: nothing to announce either way. */
  | 'signed-in';

/**
 * @param form which form the code was typed into
 * @param isNewAccount the API's answer. Missing (an API older than the field) is read as
 *   "existing" on the sign-up form: telling somebody their account already exists when it was
 *   in fact just made is harmless; telling them they made a new one when they did not is the
 *   defect this exists to fix.
 */
export function phoneSignInOutcome(
  form: 'sign-up' | 'sign-in',
  isNewAccount: boolean | undefined,
): PhoneSignInOutcome {
  if (form === 'sign-in') return 'signed-in';
  return isNewAccount === true ? 'created' : 'existing';
}

/** Calling codes this platform knows, longest first so +971 is never read as +9. */
const KNOWN_CODES: readonly string[] = [...new Set(MARKETS.map((m) => m.callingCode))].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

/**
 * The calling code of an E.164 number, as `+91` / `+1`, or null when it is not one this
 * platform sells in (or the value is not E.164 at all).
 *
 * ── A FACT ABOUT THE NUMBER, NOT ABOUT THE PERSON ──────────────────────────────────
 * +1 is the United States AND Canada, and a person with an Indian number may live anywhere.
 * This is never a country of residence and nothing may treat it as one.
 */
export function phoneCallingCode(e164: string | null | undefined): string | null {
  const value = (e164 ?? '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return null;
  const digits = value.slice(1);
  const code = KNOWN_CODES.find((c) => digits.startsWith(c));
  return code ? `+${code}` : null;
}

/**
 * The calling code with the countries that share it: `+91 (IN)`, `+1 (US/CA)`. Null when the
 * code is unknown. The label an operator reads, so the ambiguity of +1 is on screen.
 */
export function phoneCallingCodeLabel(e164: string | null | undefined): string | null {
  const code = phoneCallingCode(e164);
  if (!code) return null;
  const markets = marketsForE164(e164 ?? '');
  return markets.length ? `${code} (${markets.join('/')})` : code;
}

/** Where a stored `User.detectedCountry` came from. Only one source exists today. */
export const DETECTED_COUNTRY_SOURCES = ['network'] as const;
export type DetectedCountrySource = (typeof DETECTED_COUNTRY_SOURCES)[number];

/**
 * Countries a person may choose as where they live (`User.countryOfResidence`). The markets this
 * platform operates in; optional, never inferred, never required.
 */
export const RESIDENCE_COUNTRIES: readonly { code: string; name: string }[] = MARKETS.map((m) => ({
  code: m.code,
  name: m.name,
}));

export function isResidenceCountry(code: string | null | undefined): code is string {
  return RESIDENCE_COUNTRIES.some((c) => c.code === code);
}
