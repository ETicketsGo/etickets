/**
 * Country matching, re-exported.
 *
 * The implementation moved to @eticketsgo/shared-types when the currency map joined it:
 * the organizer console has to show the same currency the API will charge in, and two
 * copies of a country table is exactly how those come to disagree. Re-exported here
 * because the API's own modules import it from this path.
 */
export { countryAliases, countryMatches, currencyForCountry } from '@eticketsgo/shared-types';
