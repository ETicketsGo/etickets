import { marketsForE164 } from '@eticketsgo/shared-types';

/**
 * Which numbers a sign-in code may be texted to.
 *
 * ── THE FAILURE THIS CLOSES (SMS PUMPING) ──────────────────────────────────────────
 * `normalisePhone` accepts any well-formed E.164 number, and the request-code endpoint is
 * public. So anybody could make this platform text any number on Earth, at our expense. That is
 * the shape of "SMS pumping" (also called artificially inflated traffic): a fraudster owns or
 * shares revenue on a block of expensive numbers, and drives a public OTP form to text them.
 * Each message is a few cents to us and a few cents of revenue to them; a script makes it
 * thousands a day. No account is ever created, because nobody ever reads the code.
 *
 * +1 makes it worse than it looks. The North American Numbering Plan covers the United States
 * and Canada AND some twenty other countries - Jamaica, the Dominican Republic, Trinidad, the
 * Cayman Islands, Bermuda and more. Routing reads "+1" as US/Canada, so a Jamaican number would
 * be sent as a US message and billed at Jamaican international rates. Those Caribbean ranges are
 * among the most commonly pumped destinations there are.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 * A number may receive a code only if it belongs to a market this platform has opened for
 * notifications (NOTIFICATION_MARKETS; default IN, US, CA). Then, per market:
 *
 *   - India (+91): ten digits starting 6, 7, 8 or 9. Every Indian mobile number does; a
 *     landline cannot receive a text, so it can only cost money.
 *   - US and Canada (+1): a well-formed ten-digit NANP number whose area code is NOT on the
 *     reviewed deny list below. A Canadian area code counts against Canada; anything else
 *     that passes counts against the United States.
 *   - Any other enabled market: its calling code is enough. Those markets are not open today,
 *     and whoever opens one should add its own pattern here.
 *
 * ── WHY A DENY LIST FOR +1, AND NOT A LIBRARY ──────────────────────────────────────
 * `libphonenumber-js` would answer "which country is this +1 number in" properly, but it is
 * not a dependency of this API (only a transitive one of class-validator), and adding a
 * dependency is its own review. The non-US/Canada NANP area codes are a short, slowly-changing,
 * published list (NANPA), so it is written out here. It was cross-checked against
 * libphonenumber-js 1.13.9 metadata when written: every code that library places outside the
 * US and Canada is denied, and every code it places in Canada is in `CANADA_AREA_CODES`.
 *
 * The cost of the list going stale is bounded in both directions. A NEW Caribbean area code
 * would be allowed until it is added - but the per-number limits and the daily budget
 * (`otp-sms-guard.ts`) still cap what it can cost. A new Canadian area code would be counted
 * against the US budget instead of Canada's - and still allowed.
 *
 * ── US TERRITORIES: A DECISION, WRITTEN DOWN ───────────────────────────────────────
 * Puerto Rico (787, 939) and the US Virgin Islands (340) are ALLOWED: they are US jurisdictions
 * whose numbers are reached on US carrier networks, and somebody there buying a ticket to a US
 * event is a real customer. Guam (671), the Northern Mariana Islands (670) and American Samoa
 * (684) are DENIED: they are US territories too, but in the Pacific, reached through
 * international carriers and billed at international rates, and they appear on SMS-pumping
 * lists. Nobody there is a customer of a platform selling in India and North America today.
 * Anybody refused still signs in with email.
 */

/** Why a number may not receive a code. Logged and counted; never shown to the caller. */
export type DestinationRefusal =
  | 'unknown_country'
  | 'market_not_enabled'
  | 'not_a_mobile_pattern'
  | 'nanp_non_geographic'
  | 'nanp_outside_us_ca';

export type DestinationDecision =
  { ok: true; market: string } | { ok: false; reason: DestinationRefusal; market: string | null };

/**
 * Canadian geographic area codes, from NANPA and libphonenumber-js metadata. Only used to say
 * WHICH of the two +1 markets a number belongs to, so its budget is counted in the right place.
 * Canada's non-geographic 600, 622 and 633 are refused by the repeated-digit rule below.
 */
export const CANADA_AREA_CODES: ReadonlySet<string> = new Set([
  // Alberta
  '368', '403', '587', '780', '825',
  // British Columbia
  '236', '250', '257', '604', '672', '778',
  // Manitoba
  '204', '431', '584',
  // New Brunswick
  '428', '506',
  // Newfoundland and Labrador
  '709', '879',
  // Nova Scotia and Prince Edward Island
  '782', '902',
  // Ontario
  '226', '249', '289', '343', '365', '382', '416', '437', '519', '548', '613', '647', '683',
  '705', '742', '753', '807', '905', '942',
  // Quebec
  '263', '354', '367', '418', '438', '450', '468', '514', '579', '581', '819', '873',
  // Saskatchewan
  '306', '474', '639',
  // Yukon, Northwest Territories, Nunavut
  '867',
]); // prettier-ignore

/**
 * NANP area codes that are another country, or a Pacific US territory (see the decision above).
 */
export const NANP_OUTSIDE_US_CA: ReadonlySet<string> = new Set([
  '242', // Bahamas
  '246', // Barbados
  '264', // Anguilla
  '268', // Antigua and Barbuda
  '284', // British Virgin Islands
  '345', // Cayman Islands
  '441', // Bermuda
  '473', // Grenada
  '649', // Turks and Caicos Islands
  '658', // Jamaica
  '664', // Montserrat
  '670', // Northern Mariana Islands (US, Pacific)
  '671', // Guam (US, Pacific)
  '684', // American Samoa (US, Pacific)
  '721', // Sint Maarten
  '758', // Saint Lucia
  '767', // Dominica
  '784', // Saint Vincent and the Grenadines
  '809', // Dominican Republic
  '829', // Dominican Republic
  '849', // Dominican Republic
  '868', // Trinidad and Tobago
  '869', // Saint Kitts and Nevis
  '876', // Jamaica
]);

/**
 * Area codes that are not a place, so not a phone a person carries.
 *
 * Every "easily recognisable code" - the second and third digits the same - is reserved by
 * NANPA for a service rather than a place: N11 (211 to 911), N00 (500, 600, 700, the 800
 * toll-free code and the 900 PREMIUM-RATE code), and the rest of the NYY family, which holds
 * the other toll-free codes (833 to 888) and the personal-communications codes (522, 533, 544,
 * 566, 577, 588). That rule is applied in `isNonGeographicArea`; this set adds the
 * non-geographic codes that do not have that shape.
 */
const NANP_NON_GEOGRAPHIC_EXTRA: ReadonlySet<string> = new Set([
  // Personal-communications (5XX) codes outside the NYY pattern.
  '521', '523', '524', '525', '526', '527', '528', '529', '532',
  // Inbound international and US government.
  '456', '710',
  // Reserved for future expansion of toll-free and other services.
  '880', '881', '882', '883', '884', '885', '886', '887', '889',
]); // prettier-ignore

/**
 * Exchange (the three digits after the area code) values that are not ordinary subscribers.
 * N11 is never a valid exchange; 976 is the historic premium-rate exchange; 950, 958 and 959
 * are carrier access and test codes.
 *
 * 555 is deliberately NOT here. It is the fictional range films use and that developers type
 * on a laptop (where the code is printed to the console), and a text to a 555 number costs
 * nothing special - it simply fails. Refusing it would break local sign-in to stop nothing.
 */
const NANP_SPECIAL_EXCHANGES: ReadonlySet<string> = new Set(['950', '958', '959', '976']);

function isNonGeographicArea(npa: string): boolean {
  if (npa[1] === npa[2]) return true; // N11, N00 and the other NYY codes, see above
  if (npa.startsWith('37') || npa.startsWith('96')) return true; // reserved by NANPA
  return NANP_NON_GEOGRAPHIC_EXTRA.has(npa);
}

/** Ten national digits, area code and exchange each starting 2-9: the only valid NANP form. */
const NANP_NATIONAL = /^[2-9]\d{2}[2-9]\d{6}$/;

/** An Indian mobile: ten digits, starting 6-9. */
const INDIA_MOBILE = /^[6-9]\d{9}$/;

/**
 * Decide whether a normalised E.164 number (`+` and digits, from `normalisePhone`) may be sent
 * a sign-in code, and which market it counts against.
 */
export function otpDestination(
  e164: string,
  enabledMarkets: readonly string[],
): DestinationDecision {
  const candidates = marketsForE164(e164);
  if (candidates.length === 0) return { ok: false, reason: 'unknown_country', market: null };
  const enabled = new Set(enabledMarkets);

  const digits = e164.replace(/\D/g, '');

  if (candidates.includes('US') || candidates.includes('CA')) {
    const national = digits.slice(1);
    if (!NANP_NATIONAL.test(national)) {
      return { ok: false, reason: 'not_a_mobile_pattern', market: null };
    }
    const npa = national.slice(0, 3);
    const exchange = national.slice(3, 6);
    if (NANP_OUTSIDE_US_CA.has(npa)) {
      return { ok: false, reason: 'nanp_outside_us_ca', market: null };
    }
    const n11Exchange = exchange.endsWith('11');
    if (isNonGeographicArea(npa) || n11Exchange || NANP_SPECIAL_EXCHANGES.has(exchange)) {
      return { ok: false, reason: 'nanp_non_geographic', market: null };
    }
    const market = CANADA_AREA_CODES.has(npa) ? 'CA' : 'US';
    return enabled.has(market)
      ? { ok: true, market }
      : { ok: false, reason: 'market_not_enabled', market };
  }

  // Every other calling code this platform knows belongs to exactly one market.
  const market = candidates[0];
  if (!enabled.has(market)) return { ok: false, reason: 'market_not_enabled', market };
  if (market === 'IN' && !INDIA_MOBILE.test(digits.slice(2))) {
    return { ok: false, reason: 'not_a_mobile_pattern', market };
  }
  return { ok: true, market };
}
