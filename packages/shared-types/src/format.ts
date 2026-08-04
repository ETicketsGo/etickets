/**
 * Presentation formatters for money and dates.
 *
 * These live in shared-types — the one package with no framework dependency — because
 * both the web apps and the mobile app must render the same amount the same way. The
 * alternative was a second implementation in the mobile app, and a second implementation
 * of the INR whole-rupee rule is exactly the kind of thing that drifts silently: nothing
 * fails, the app just starts showing ₹799.00 where the website shows ₹799.
 *
 * web-kit re-exports every symbol here, so web imports are unchanged.
 */

/**
 * Locale used when the caller does not supply one.
 *
 * INR gets en-IN for lakh/crore digit grouping (₹1,00,000, not ₹100,000). Everything
 * else gets en-US. The mobile app passes the device locale explicitly.
 */
function defaultLocale(currency: string): string {
  return currency === 'INR' ? 'en-IN' : 'en-US';
}

/**
 * Format an integer minor-unit amount as currency.
 *
 * Fraction digits are currency-aware. INR keeps whole rupees — the product has always shown
 * ₹799 rather than ₹799.00 and prices are whole-rupee in practice. Everything else keeps its
 * sub-unit, because rounding to whole units turns a $9.99 fee band into "$10" and makes
 * adjacent bands ($9.99 / $10.00) look identical in the admin table.
 */
export function money(minor: number | null | undefined, currency = 'INR', locale?: string): string {
  if (minor == null) return '—';
  const wholeUnits = currency === 'INR';
  return new Intl.NumberFormat(locale ?? defaultLocale(currency), {
    style: 'currency',
    currency,
    ...(wholeUnits ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2 }),
  }).format(minor / 100);
}

export function dateTime(
  value: string | Date | null | undefined,
  locale = 'en-IN',
  timeZone?: string,
): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

export function dateOnly(
  value: string | Date | null | undefined,
  locale = 'en-IN',
  timeZone?: string,
): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(locale, {
    dateStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  });
}

export function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
