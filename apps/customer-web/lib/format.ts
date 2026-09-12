import { useLocale } from 'next-intl';
import { formatFor, type LocaleFormat } from '@eticketsgo/web-kit';

/**
 * The module-level formatters, always in English formats.
 *
 * Kept for code that is not rendering customer-facing text in the reader's language. Anything a
 * customer reads should use `useFormat()` instead, or a French page shows "19 Sept 2026, 6:30 pm"
 * and "₹1,039.60" in the middle of French copy.
 */
export { money, dateTime, dateOnly, titleCase, zoneAbbrev } from '@eticketsgo/web-kit';

/**
 * Money and date formatters in the reader's language.
 *
 * Returns functions with the SAME signatures as the module-level ones, so a call site switches
 * with `const { money, dateTime } = useFormat();` and nothing else changes. English output is
 * byte-identical to the module functions (en-IN / en-US, as it always was); fr-CA formats as
 * "1 039,60 ₹" and "19 sept. 2026, 18 h 30". The venue time zone is still whatever the call
 * site passes, and the zone abbreviation is unchanged.
 *
 * Reads the locale next-intl resolved for the request, which is the same on the server and in
 * the hydrating client — never the machine's default locale.
 */
export function useFormat(): LocaleFormat {
  return formatFor(useLocale());
}
