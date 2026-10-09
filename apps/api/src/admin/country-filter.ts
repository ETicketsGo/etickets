import { z } from 'zod';
import { countryAliases } from '@eticketsgo/shared-types';

/**
 * One country filter, meaning the same thing on every admin list that offers it.
 *
 * ── WHY A SEPARATE FILTER AND NOT THE GROUPED SUMMARY'S `groupKey` ──────────────────
 * The grouped summary already narrows a list to one country, but only to one STORED spelling of
 * it: its key is whatever `Venue.country` holds, so "India", "india" and "IN" are three chips and
 * picking one hides the other two. That is right for a summary - it shows the data as it is - and
 * wrong for a filter somebody picks from a list of markets and expects to mean the whole market.
 *
 * So this takes an ISO alpha-2 code, which is what a market is, and matches every spelling of
 * that country through `countryAliases` - the same tolerance the account directory and discovery
 * already use. It is ANDed with the grouped scope rather than replacing it, so the two can be
 * used together ("India, grouped by organizer, this organizer").
 *
 * ── WHY A CODE AND NOT ANY SPELLING ────────────────────────────────────────────────
 * The value lives in the URL so it survives a refresh and can be sent to a colleague. A code is
 * the one spelling that is short, unambiguous and the same in every link; refusing anything else
 * with a 400 means a hand-edited link that says `country=Inda` fails loudly instead of quietly
 * showing an empty list that looks like "nothing sold in India".
 */
export const countryFilterField = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use a 2-letter ISO country code, for example IN or US.')
  .transform((v) => v.toUpperCase())
  .optional();

/** The lists that accept it, and the stored column that says where each row is. */
export type CountryFilterable = 'bookings' | 'events' | 'organizers';

/**
 * Where each list keeps its country.
 *
 * Bookings and events are where the VENUE is, the same column the grouped summary counts by; an
 * organizer is where it is registered. Kept beside the SQL column below so the list and its
 * summary cannot come to mean different countries.
 */
const PATHS: Record<CountryFilterable, (match: unknown) => Record<string, unknown>> = {
  bookings: (match) => ({ event: { venue: { country: match } } }),
  events: (match) => ({ venue: { country: match } }),
  organizers: (match) => ({ registeredCountry: match }),
};

/** The same columns, for the grouped summary's raw SQL. */
export const COUNTRY_COLUMNS: Record<CountryFilterable, string> = {
  bookings: 'v.country',
  events: 'v.country',
  organizers: 'o."registeredCountry"',
};

/**
 * The Prisma `where` fragment for a country, or null when no country was asked for.
 *
 * Returned as a fragment for the caller to put inside `AND`, never spread at the top level: the
 * grouped scope can produce the same top-level key (`venue`, `event`), and a spread would let one
 * silently overwrite the other.
 */
export function countryWhere(
  resource: CountryFilterable,
  code: string | undefined,
): Record<string, unknown> | null {
  if (!code) return null;
  return PATHS[resource]({ in: countryAliases(code), mode: 'insensitive' });
}
