import { MARKETS, marketFor, type TaxRegistrationType } from './markets';

/**
 * The rules for the contact and tax fields an organizer fills in on Settings.
 *
 * ── ONE DEFINITION FOR THE FORM AND THE API ─────────────────────────────────────────
 * The console checks a field as it is typed and the API checks it again on save. Two copies of
 * a rule drift, and a form that passes what the server refuses (or the other way round) is a
 * form that loses somebody's work. Both import these functions.
 *
 * Every function returns the message to show under the field, or null. Blank is never a
 * problem here: whether a field is required is a separate business rule (the readiness list).
 */

// ── Names ────────────────────────────────────────────────────────────────────────────

/** Letters in any script, combining marks, spaces, hyphens, apostrophes and full stops. */
const NAME_CHARACTERS = /^[\p{L}\p{M}][\p{L}\p{M} '’.\-]*$/u;
export const CONTACT_NAME_MIN = 5;

export function contactNameProblem(name: string | null | undefined): string | null {
  const v = (name ?? '').trim();
  if (!v) return null;
  // Counted in characters a person sees, not UTF-16 units: "Zoë" is three letters.
  if ([...v].length < CONTACT_NAME_MIN) {
    return `Enter at least ${CONTACT_NAME_MIN} characters, for example a first and last name.`;
  }
  if (!NAME_CHARACTERS.test(v)) {
    return 'Use letters, spaces, hyphens or apostrophes only.';
  }
  return null;
}

// ── Email ────────────────────────────────────────────────────────────────────────────

/*
  Stricter than "has an @", looser than a Latin-only regex: the local part and every domain
  label may be in any script (an internationalised address such as "info@bücher.de" or a
  punycode "xn--" domain is valid mail), but there must be a domain with a dot, no spaces, and
  no empty or dot-edged parts.
*/
const LOCAL_PART =
  /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?$/u;
const TOP_LEVEL = /^(?:\p{L}[\p{L}\p{M}]{1,62}|xn--[a-z0-9-]{1,59})$/iu;

export function contactEmailProblem(email: string | null | undefined): string | null {
  const v = (email ?? '').trim();
  if (!v) return null;
  const message = 'Enter a valid email address, for example name@company.com.';
  if (v.length > 254) return message;
  const at = v.lastIndexOf('@');
  if (at <= 0 || at !== v.indexOf('@')) return message;
  const local = v.slice(0, at);
  const labels = v.slice(at + 1).split('.');
  if (local.length > 64 || !LOCAL_PART.test(local)) return message;
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l))) return message;
  if (!TOP_LEVEL.test(labels[labels.length - 1])) return message;
  return null;
}

// ── Phone ────────────────────────────────────────────────────────────────────────────

/*
  The national number's shape per country. Not every number is ten digits: a Singapore number
  is eight, a UK one nine or ten. The ones here are the countries we sell in (MARKETS).
  India accepts mobiles (6-9) and landlines with their STD code; a field that needs a mobile
  says so with `mobileOnly`.
*/
const NATIONAL: Readonly<Record<string, { pattern: RegExp; length: string; mobile?: RegExp }>> = {
  US: { pattern: /^[2-9]\d{2}[2-9]\d{6}$/, length: '10 digits' },
  CA: { pattern: /^[2-9]\d{2}[2-9]\d{6}$/, length: '10 digits' },
  IN: { pattern: /^[1-9]\d{9}$/, length: '10 digits', mobile: /^[6-9]\d{9}$/ },
  GB: { pattern: /^[1-9]\d{8,9}$/, length: '9 or 10 digits' },
  AE: { pattern: /^[1-9]\d{7,8}$/, length: '8 or 9 digits' },
  SG: { pattern: /^[3689]\d{7}$/, length: '8 digits' },
  AU: { pattern: /^[1-9]\d{8}$/, length: '9 digits' },
  NZ: { pattern: /^[2-9]\d{7,9}$/, length: '8 to 10 digits' },
};

/** Longest calling code first, so +971 is not read as +9. US before CA for +1 (MARKETS order). */
const BY_CODE = [...MARKETS].sort((a, b) => b.callingCode.length - a.callingCode.length);

/**
 * Why this number cannot be saved, or null.
 *
 * Takes the stored form, E.164 (`+12085550100`). `country` picks between countries that share
 * a calling code (the US and Canada); without it the first market with the code is used.
 */
export function phoneProblem(
  e164: string | null | undefined,
  options: { country?: string | null; mobileOnly?: boolean } = {},
): string | null {
  const v = (e164 ?? '').trim();
  if (!v) return null;
  if (!/^\+\d{6,15}$/.test(v)) return 'Enter the number using digits only.';
  const digits = v.slice(1);
  const chosen = marketFor(options.country);
  const market =
    chosen && digits.startsWith(chosen.callingCode)
      ? chosen
      : BY_CODE.find((m) => digits.startsWith(m.callingCode));
  if (!market) return 'Choose the country this number is in.';
  const national = digits.slice(market.callingCode.length);
  const rule = NATIONAL[market.code];
  if (!rule) return national.length >= 6 && national.length <= 12 ? null : 'Check the number.';
  if (options.mobileOnly && rule.mobile && !rule.mobile.test(national)) {
    return `Enter a ${rule.length} ${market.name} mobile number.`;
  }
  if (!rule.pattern.test(national)) {
    return `Enter a valid ${market.name} number: ${rule.length}, without the leading 0.`;
  }
  return null;
}

// ── Tax registrations ────────────────────────────────────────────────────────────────

/** The registrations a country's organizer can choose from, or null for free text. */
export function taxRegistrationTypes(
  country: string | null | undefined,
): readonly TaxRegistrationType[] | null {
  return marketFor(country)?.taxRegistrationTypes ?? null;
}

/** The type a stored kind refers to in this country, matched without regard to case. */
export function taxRegistrationType(
  country: string | null | undefined,
  kind: string | null | undefined,
): TaxRegistrationType | null {
  const k = (kind ?? '').trim().toLowerCase();
  if (!k) return null;
  return taxRegistrationTypes(country)?.find((t) => t.kind.toLowerCase() === k) ?? null;
}

/**
 * Why this registration number cannot be saved for this type, or null.
 *
 * A kind the country's list does not know (an older free-text "GST/HST") is not checked: the
 * platform records what it cannot judge rather than refusing it.
 */
export function taxRegistrationNumberProblem(
  country: string | null | undefined,
  kind: string | null | undefined,
  number: string | null | undefined,
): string | null {
  const v = (number ?? '').trim();
  const type = taxRegistrationType(country, kind);
  if (!type) return null;
  if (type.notRegistered)
    return v ? 'Remove the number, or choose the registration it belongs to.' : null;
  if (!v) return null;
  if (marketFor(country)?.code === 'US' && /^\d{3}-\d{2}-\d{4}$/.test(v)) {
    return 'This looks like a personal SSN or ITIN. Enter the business registration number instead.';
  }
  const shaped = type.number!.uppercase ? v.toUpperCase() : v;
  if (!type.number!.pattern.test(shaped)) {
    return `Enter a valid ${type.kind}, for example ${type.number!.example}.`;
  }
  return null;
}

/** One registration beyond the main one: a second state's sales tax ID, a PAN beside a GSTIN. */
export interface AdditionalTaxRegistration {
  kind: string;
  number: string;
}
