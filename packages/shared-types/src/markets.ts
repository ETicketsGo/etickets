import { INDIA_STATES } from './india-states';

/**
 * The countries this platform sells in, and what a seller has to say about a place in each.
 *
 * ── WHY A LIST AND NOT A TEXT BOX ──────────────────────────────────────────────────
 * Country was a free-text field on every venue form. "India", "india", "IN" and "Inida" all
 * saved happily, and each one lands somewhere that matters: `currencyForCountry` decides what
 * an organizer prices in, payment routing decides which provider takes the money, and the tax
 * engine decides which rules can apply at all. A typo does not fail — it silently returns
 * null, and a null falls back to a default nobody chose. That is how a venue in Boise ends up
 * priced in rupees.
 *
 * The list is deliberately SHORT. These are the markets the platform has currency, payment
 * routing and fee configuration for; offering a country we cannot take money in would be an
 * invitation to build an event nobody can buy a ticket to.
 *
 * ── WHY IT LIVES HERE ──────────────────────────────────────────────────────────────
 * The same eight countries were already written out twice — `COUNTRY_CURRENCY` in
 * `country.ts` and again in web-kit's `locale.ts` — with no relationship between them. This
 * is the one definition those should agree with, and it carries the two things a form needs
 * that neither of them had: what the country calls its subdivisions, and which timezones a
 * venue there could plausibly be in.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────────────
 * No tax rates, no fee percentages, no payment provider names. Those are decisions with
 * regulatory and commercial weight and they live with the engines that own them. This is
 * reference data: names of places, and the zones they keep time in.
 */

export interface MarketRegion {
  /** The value stored and compared. The full name, as people write it. */
  name: string;
  /** Short form, where one is in common use. */
  abbr?: string;
}

export interface Market {
  /** ISO-3166 alpha-2. */
  code: string;
  /** The name stored in `Venue.country` and shown in a dropdown. */
  name: string;
  /** ISO-4217. What a seller in this country prices and is paid in. */
  currency: string;
  /**
   * The E.164 country calling code, without a `+`.
   *
   * Here because a phone number cannot be read, written or dialled without one, and this
   * file already exists to stop country facts being retyped per feature. Two private copies
   * of this table were in the codebase before it moved here: the notification router's and
   * the log masker's. A third was about to be typed into the sign-in form.
   *
   * Shared codes are real: +1 is both the United States and Canada, and a number alone
   * cannot tell them apart. Anything that needs the country rather than the code must ask,
   * not infer.
   */
  callingCode: string;
  /**
   * The legal forms a business in this country actually takes.
   *
   * ── WHY THIS IS A LIST PER COUNTRY AND NOT FREE TEXT ───────────────────────────────
   * "Registered legal name" alone does not say what somebody registered AS, and an admin
   * approving an organizer is deciding whether a real, identifiable party may take money
   * from the public. A sole proprietor in India and a Pvt Ltd are different things with
   * different obligations, and a text box collects neither reliably - it collects "pvt",
   * "Private Ltd.", "PVT LTD" and a blank.
   *
   * Per country because the forms are not the same anywhere: a US LLC does not exist in
   * India, a Pty Ltd is Australian, and offering an organizer a list containing neither
   * their own form nor an honest "other" teaches them to pick something wrong.
   *
   * The first entry is the one most small organizers are, which is what an empty form
   * should not quietly assume but a reviewer should expect to see most.
   */
  legalEntityTypes: readonly string[];
  /**
   * What this country calls the tax registration an invoice quotes - GSTIN, EIN, VAT.
   *
   * A label, not a validator. Every authority owns its own format and changes it without
   * consulting this repository, so the platform records what the organizer states and the
   * authority decides whether it is valid.
   */
  taxRegistrationLabel: string;
  /**
   * What this country calls its first-level subdivisions.
   *
   * Not cosmetic. Asking a Canadian for their "state" or an Emirati for their "province"
   * reads as a form built for somewhere else — which is precisely the impression a platform
   * entering a market cannot afford.
   */
  regionLabel: string;
  /**
   * The subdivisions, where a stable public list exists and an address actually uses one.
   *
   * Empty means "this country does not work that way" — Singapore has no meaningful
   * subdivision in an address — and the form asks nothing rather than asking for something
   * that has no answer.
   */
  regions: readonly MarketRegion[];
  /**
   * IANA zones a venue in this country could be in, most populous first.
   *
   * A start time means the time AT THE VENUE. Every venue previously defaulted to
   * `Asia/Kolkata` regardless of country, so a show in Chicago was stored, displayed and
   * printed on a ticket in Indian time — the exact defect this codebase has already fixed
   * twice, still live for any venue created outside India. The first entry is the default,
   * and a country with one zone never asks.
   */
  timezones: readonly string[];
}

/**
 * India's states and union territories, from the GST reference list, sorted by NAME.
 *
 * `INDIA_STATES` is ordered by GST state code, which is how the official list is published
 * and is the right order for that file. It is the wrong order for a dropdown: it opens on
 * Jammu and Kashmir, puts Assam above West Bengal, and leaves somebody scrolling a list of
 * thirty-odd entries with no order they can predict. Sorted here rather than there, so the
 * reference data keeps its meaning and the form gets an order a person can scan.
 */
const IN_REGIONS: readonly MarketRegion[] = [...INDIA_STATES]
  .map((s) => ({ name: s.name, abbr: s.abbr }))
  .sort((a, b) => a.name.localeCompare(b.name));

const US_REGIONS: readonly MarketRegion[] = [
  { name: 'Alabama', abbr: 'AL' },
  { name: 'Alaska', abbr: 'AK' },
  { name: 'Arizona', abbr: 'AZ' },
  { name: 'Arkansas', abbr: 'AR' },
  { name: 'California', abbr: 'CA' },
  { name: 'Colorado', abbr: 'CO' },
  { name: 'Connecticut', abbr: 'CT' },
  { name: 'Delaware', abbr: 'DE' },
  { name: 'District of Columbia', abbr: 'DC' },
  { name: 'Florida', abbr: 'FL' },
  { name: 'Georgia', abbr: 'GA' },
  { name: 'Hawaii', abbr: 'HI' },
  { name: 'Idaho', abbr: 'ID' },
  { name: 'Illinois', abbr: 'IL' },
  { name: 'Indiana', abbr: 'IN' },
  { name: 'Iowa', abbr: 'IA' },
  { name: 'Kansas', abbr: 'KS' },
  { name: 'Kentucky', abbr: 'KY' },
  { name: 'Louisiana', abbr: 'LA' },
  { name: 'Maine', abbr: 'ME' },
  { name: 'Maryland', abbr: 'MD' },
  { name: 'Massachusetts', abbr: 'MA' },
  { name: 'Michigan', abbr: 'MI' },
  { name: 'Minnesota', abbr: 'MN' },
  { name: 'Mississippi', abbr: 'MS' },
  { name: 'Missouri', abbr: 'MO' },
  { name: 'Montana', abbr: 'MT' },
  { name: 'Nebraska', abbr: 'NE' },
  { name: 'Nevada', abbr: 'NV' },
  { name: 'New Hampshire', abbr: 'NH' },
  { name: 'New Jersey', abbr: 'NJ' },
  { name: 'New Mexico', abbr: 'NM' },
  { name: 'New York', abbr: 'NY' },
  { name: 'North Carolina', abbr: 'NC' },
  { name: 'North Dakota', abbr: 'ND' },
  { name: 'Ohio', abbr: 'OH' },
  { name: 'Oklahoma', abbr: 'OK' },
  { name: 'Oregon', abbr: 'OR' },
  { name: 'Pennsylvania', abbr: 'PA' },
  { name: 'Rhode Island', abbr: 'RI' },
  { name: 'South Carolina', abbr: 'SC' },
  { name: 'South Dakota', abbr: 'SD' },
  { name: 'Tennessee', abbr: 'TN' },
  { name: 'Texas', abbr: 'TX' },
  { name: 'Utah', abbr: 'UT' },
  { name: 'Vermont', abbr: 'VT' },
  { name: 'Virginia', abbr: 'VA' },
  { name: 'Washington', abbr: 'WA' },
  { name: 'West Virginia', abbr: 'WV' },
  { name: 'Wisconsin', abbr: 'WI' },
  { name: 'Wyoming', abbr: 'WY' },
];

const CA_REGIONS: readonly MarketRegion[] = [
  { name: 'Alberta', abbr: 'AB' },
  { name: 'British Columbia', abbr: 'BC' },
  { name: 'Manitoba', abbr: 'MB' },
  { name: 'New Brunswick', abbr: 'NB' },
  { name: 'Newfoundland and Labrador', abbr: 'NL' },
  { name: 'Northwest Territories', abbr: 'NT' },
  { name: 'Nova Scotia', abbr: 'NS' },
  { name: 'Nunavut', abbr: 'NU' },
  { name: 'Ontario', abbr: 'ON' },
  { name: 'Prince Edward Island', abbr: 'PE' },
  { name: 'Quebec', abbr: 'QC' },
  { name: 'Saskatchewan', abbr: 'SK' },
  { name: 'Yukon', abbr: 'YT' },
];

const AU_REGIONS: readonly MarketRegion[] = [
  { name: 'Australian Capital Territory', abbr: 'ACT' },
  { name: 'New South Wales', abbr: 'NSW' },
  { name: 'Northern Territory', abbr: 'NT' },
  { name: 'Queensland', abbr: 'QLD' },
  { name: 'South Australia', abbr: 'SA' },
  { name: 'Tasmania', abbr: 'TAS' },
  { name: 'Victoria', abbr: 'VIC' },
  { name: 'Western Australia', abbr: 'WA' },
];

const NZ_REGIONS: readonly MarketRegion[] = [
  { name: 'Auckland' },
  { name: 'Bay of Plenty' },
  { name: 'Canterbury' },
  { name: 'Gisborne' },
  { name: "Hawke's Bay" },
  { name: 'Manawatū-Whanganui' },
  { name: 'Marlborough' },
  { name: 'Nelson' },
  { name: 'Northland' },
  { name: 'Otago' },
  { name: 'Southland' },
  { name: 'Taranaki' },
  { name: 'Tasman' },
  { name: 'Waikato' },
  { name: 'Wellington' },
  { name: 'West Coast' },
];

const AE_REGIONS: readonly MarketRegion[] = [
  { name: 'Abu Dhabi' },
  { name: 'Ajman' },
  { name: 'Dubai' },
  { name: 'Fujairah' },
  { name: 'Ras Al Khaimah' },
  { name: 'Sharjah' },
  { name: 'Umm Al Quwain' },
];

const GB_REGIONS: readonly MarketRegion[] = [
  { name: 'England' },
  { name: 'Northern Ireland' },
  { name: 'Scotland' },
  { name: 'Wales' },
];

/**
 * Ordered by where the platform actually sells, not alphabetically.
 *
 * India first because it is the launch market and the overwhelming majority of venues will
 * be there — a form that opens on the answer most people need is a form most people do not
 * have to touch.
 */
/*
  Every region list is presented alphabetically. Asserted in `markets.spec.ts` rather than
  left to whoever adds the next market: a list that is sorted by accident stops being sorted
  the first time somebody appends to it.
*/
export const MARKETS: readonly Market[] = [
  {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    callingCode: '91',
    legalEntityTypes: [
      'Sole proprietorship',
      'Partnership firm',
      'LLP',
      'Private limited company',
      'Public limited company',
      'Trust',
      'Society',
      'Hindu undivided family',
      'Individual',
    ],
    taxRegistrationLabel: 'GSTIN',
    regionLabel: 'State',
    regions: IN_REGIONS,
    timezones: ['Asia/Kolkata'],
  },
  {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    callingCode: '1',
    legalEntityTypes: [
      'Sole proprietor',
      'Single-member LLC',
      'LLC',
      'S corporation',
      'C corporation',
      'Partnership',
      'Non-profit',
      'Individual',
    ],
    taxRegistrationLabel: 'EIN',
    regionLabel: 'State',
    regions: US_REGIONS,
    timezones: [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'America/Los_Angeles',
      'America/Anchorage',
      'Pacific/Honolulu',
    ],
  },
  {
    code: 'CA',
    name: 'Canada',
    currency: 'CAD',
    callingCode: '1',
    legalEntityTypes: [
      'Sole proprietorship',
      'Partnership',
      'Corporation',
      'Co-operative',
      'Non-profit',
      'Individual',
    ],
    taxRegistrationLabel: 'GST/HST number',
    regionLabel: 'Province or territory',
    regions: CA_REGIONS,
    timezones: [
      'America/Toronto',
      'America/Vancouver',
      'America/Edmonton',
      'America/Winnipeg',
      'America/Halifax',
      'America/Regina',
      'America/St_Johns',
    ],
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    callingCode: '44',
    legalEntityTypes: [
      'Sole trader',
      'Partnership',
      'LLP',
      'Private limited company',
      'Public limited company',
      'Charity',
      'Individual',
    ],
    taxRegistrationLabel: 'VAT number',
    regionLabel: 'Nation',
    regions: GB_REGIONS,
    timezones: ['Europe/London'],
  },
  {
    code: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    callingCode: '971',
    legalEntityTypes: [
      'Sole establishment',
      'LLC',
      'Free zone company',
      'Civil company',
      'Branch of a foreign company',
      'Individual',
    ],
    taxRegistrationLabel: 'TRN',
    regionLabel: 'Emirate',
    regions: AE_REGIONS,
    timezones: ['Asia/Dubai'],
  },
  {
    code: 'SG',
    name: 'Singapore',
    currency: 'SGD',
    callingCode: '65',
    legalEntityTypes: [
      'Sole proprietorship',
      'Partnership',
      'LLP',
      'Private limited company',
      'Individual',
    ],
    taxRegistrationLabel: 'GST registration number',
    regionLabel: 'Region',
    // A Singapore address has no state, province or equivalent. Asking would be asking for
    // something with no answer, so the field is simply not shown.
    regions: [],
    timezones: ['Asia/Singapore'],
  },
  {
    code: 'AU',
    name: 'Australia',
    currency: 'AUD',
    callingCode: '61',
    legalEntityTypes: [
      'Sole trader',
      'Partnership',
      'Company (Pty Ltd)',
      'Trust',
      'Not-for-profit',
      'Individual',
    ],
    taxRegistrationLabel: 'ABN',
    regionLabel: 'State or territory',
    regions: AU_REGIONS,
    timezones: [
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Perth',
      'Australia/Adelaide',
      'Australia/Hobart',
      'Australia/Darwin',
    ],
  },
  {
    code: 'NZ',
    name: 'New Zealand',
    currency: 'NZD',
    callingCode: '64',
    legalEntityTypes: [
      'Sole trader',
      'Partnership',
      'Limited company',
      'Trust',
      'Incorporated society',
      'Individual',
    ],
    taxRegistrationLabel: 'GST number',
    regionLabel: 'Region',
    regions: NZ_REGIONS,
    timezones: ['Pacific/Auckland', 'Pacific/Chatham'],
  },
];

/** The market this platform defaults to when nothing better is known. */
export const DEFAULT_MARKET = MARKETS[0];

/**
 * The market a stored country value refers to, in any spelling, or null.
 *
 * Tolerant on purpose: `Venue.country` holds whatever was typed before this list existed —
 * "India", "india", "IN" — and a lookup that only matched the canonical name would treat
 * every historic row as an unknown country.
 */
export function marketFor(country: string | null | undefined): Market | null {
  if (!country) return null;
  const needle = country.trim().toLowerCase();
  if (!needle) return null;
  return (
    MARKETS.find(
      (m) =>
        m.code.toLowerCase() === needle ||
        m.name.toLowerCase() === needle ||
        // "USA", "UK", "United States of America" — the spellings already in the database.
        EXTRA_SPELLINGS[m.code]?.includes(needle),
    ) ?? null
  );
}

/** Spellings that reach a market but are not its code or its canonical name. */
const EXTRA_SPELLINGS: Record<string, string[]> = {
  US: ['usa', 'united states of america', 'u.s.', 'u.s.a.'],
  GB: ['uk', 'great britain', 'england'],
  AE: ['uae'],
};

/**
 * The subdivision a stored region value refers to, in any spelling, or null.
 *
 * Same tolerance, same reason: `Venue.region` is nullable and was never editable through the
 * product, so anything already in it arrived from a seed or a migration.
 */
export function regionFor(country: string | null | undefined, region: string | null | undefined) {
  const market = marketFor(country);
  if (!market || !region) return null;
  const needle = region.trim().toLowerCase();
  return (
    market.regions.find(
      (r) => r.name.toLowerCase() === needle || r.abbr?.toLowerCase() === needle,
    ) ?? null
  );
}

/**
 * The market to open a form on, given a hint about where the person is.
 *
 * The hint is a HINT — a browser locale, which reports the language settings rather than the
 * body. It picks the default and nothing else: the field stays a dropdown, the value stays
 * editable, and nothing is priced, taxed or routed on the strength of it. A wrong guess must
 * cost one click, never a wrong charge.
 */
export function marketFromHint(hint: string | null | undefined): Market {
  return marketFor(hint) ?? DEFAULT_MARKET;
}
