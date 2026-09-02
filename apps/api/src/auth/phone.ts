import { HttpStatus } from '@nestjs/common';
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

/** The launch market. A bare national number is assumed to be from here. */
const DEFAULT_COUNTRY_CODE = '91';

/** Indian mobile numbers are ten digits and never start with 0–5. */
const NATIONAL_LENGTH = 10;

export function normalisePhone(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'Enter a mobile number.',
      HttpStatus.BAD_REQUEST,
    );
  }

  const hadPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');

  if (!hadPlus) {
    // `00` is the other way of writing `+`, and a single leading `0` is the domestic trunk
    // prefix — neither is part of the number.
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.length === NATIONAL_LENGTH + 1 && digits.startsWith('0'))
      digits = digits.slice(1);
    if (digits.length === NATIONAL_LENGTH) digits = `${DEFAULT_COUNTRY_CODE}${digits}`;
  }

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

/** The last four digits, for telling somebody which number a code went to. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return digits.length <= 4 ? '••••' : `••••••${digits.slice(-4)}`;
}
