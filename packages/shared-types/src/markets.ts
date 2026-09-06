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

/** India's states and union territories, from the GST reference list. */
const IN_REGIONS: readonly MarketRegion[] = INDIA_STATES.map((s) => ({
  name: s.name,
  abbr: s.abbr,
}));

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
  { name: 'Scotland' },
  { name: 'Wales' },
  { name: 'Northern Ireland' },
];

/**
 * Ordered by where the platform actually sells, not alphabetically.
 *
 * India first because it is the launch market and the overwhelming majority of venues will
 * be there — a form that opens on the answer most people need is a form most people do not
 * have to touch.
 */
export const MARKETS: readonly Market[] = [
  {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    regionLabel: 'State',
    regions: IN_REGIONS,
    timezones: ['Asia/Kolkata'],
  },
  {
    code: 'US',
    name: 'United States',
    currency: 'USD',
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
    regionLabel: 'Nation',
    regions: GB_REGIONS,
    timezones: ['Europe/London'],
  },
  {
    code: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    regionLabel: 'Emirate',
    regions: AE_REGIONS,
    timezones: ['Asia/Dubai'],
  },
  {
    code: 'SG',
    name: 'Singapore',
    currency: 'SGD',
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
