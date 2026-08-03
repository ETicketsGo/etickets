/**
 * Format an integer minor-unit amount as currency.
 *
 * Fraction digits are currency-aware. INR keeps whole rupees — the product has always shown
 * ₹799 rather than ₹799.00 and prices are whole-rupee in practice. Everything else keeps its
 * sub-unit, because rounding to whole units turns a $9.99 fee band into "$10" and makes
 * adjacent bands ($9.99 / $10.00) look identical in the admin table.
 */
export function money(minor: number | null | undefined, currency = 'INR'): string {
  if (minor == null) return '—';
  const wholeUnits = currency === 'INR';
  return new Intl.NumberFormat(wholeUnits ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    ...(wholeUnits ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2 }),
  }).format(minor / 100);
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

export function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
