import { HttpStatus } from '@nestjs/common';
import { MARKETS } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * One canonical spelling of a mobile number.
 *
 * ── WHY THIS IS NOT `replace(/\D/g, '')` ───────────────────────────────────────────
 * A number arrives typed by a person: `97044 64007`, `+91 97044 64007`, `097044-64007`,
 * `0091 9704464007`. Every one of those is the same phone, and every one of them is a
 * different string. Storing them as typed gives one person several accounts, none of which
 * has their tickets in it — and a `@unique` column enforces nothing at all, because the
 * duplicates are not equal.
 *
 * ── WHY A DEFAULT COUNTRY, AND WHY IT IS EXPLICIT ──────────────────────────────────
 * A bare ten-digit number has no country in it. Assuming India is right for the launch
 * market and wrong the day somebody signs in from anywhere else, so the assumption is named
 * here rather than buried: anything already carrying a `+` is taken at its word, and only a
 * bare national number gets the default prefix.
 */

/** The calling codes this platform sells in, longest first so +971 is not read as +9. */
const CALLING_CODES: readonly string[] = [...new Set(MARKETS.map((m) => m.callingCode))].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

export function normalisePhone(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'Enter a mobile number.',
      HttpStatus.BAD_REQUEST,
    );
  }

  let digits = raw.replace(/\D/g, '');
  // `00` is the other way of writing `+`.
  const international = raw.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (!international) {
    /*
      A bare national number does not say which country it is from, and this is the one place
      that cannot guess. It used to assume India, which is correct for the launch market and
      silently wrong everywhere else: ten digits is also the national length in the United
      States and Canada, so `4155550132` became `+914155550132` — a real Indian number
      belonging to somebody else, who then received a stranger's sign-in code. Refusing is the
      only answer that cannot send a code to the wrong person.
    */
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'Start your number with the country code, for example +91 or +1.',
      HttpStatus.BAD_REQUEST,
    );
  }

  digits = withoutTrunkPrefix(digits);

  /*
    Bounds from E.164: a country code plus a subscriber number is never shorter than eight
    digits and never longer than fifteen. Deliberately NOT a per-country pattern — this
    platform already sells in two countries and a regex per market is a list somebody
    forgets to extend, which rejects a real customer's real number.
  */
  if (digits.length < 8 || digits.length > 15) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'That does not look like a mobile number.',
      HttpStatus.BAD_REQUEST,
    );
  }

  return `+${digits}`;
}

/**
 * Drops the domestic trunk `0` somebody kept when they wrote their number in full:
 * `+91 09704464007`. Left in, it is a different number from `+919704464007`, so the same
 * person gets a second account and neither has their tickets in it.
 *
 * Only applied after a calling code this platform actually sells in, because a leading zero
 * is not always a trunk prefix: an Italian number keeps it (+39 06…). Italy is not a market
 * here, and restricting the rule to known codes means adding one cannot break that country
 * by accident.
 */
function withoutTrunkPrefix(digits: string): string {
  for (const code of CALLING_CODES) {
    if (digits.startsWith(code) && digits[code.length] === '0') {
      return `${code}${digits.slice(code.length + 1)}`;
    }
  }
  return digits;
}

/** The last four digits, for telling somebody which number a code went to. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return digits.length <= 4 ? '••••' : `••••••${digits.slice(-4)}`;
}
