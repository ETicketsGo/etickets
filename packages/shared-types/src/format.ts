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
 * How many fraction digits this currency actually has, asked of `Intl` rather than assumed.
 *
 * Two for INR and USD, none for JPY, three for KWD. The old code hardcoded
 * `minimumFractionDigits: 2` for everything that was not INR, which renders ¥1,234.56 for a
 * currency that has no sub-unit at all.
 */
function currencyFractionDigits(currency: string, locale: string): number {
  try {
    return (
      new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Digits to render ONE amount with.
 *
 * ── THE INR RULE, AND WHY IT CHANGED ───────────────────────────────────────────────
 * INR used to be pinned to whole rupees, because Indian ticket prices are whole rupees in
 * practice and "₹799.00" is noise. True of a ticket price; false of a total. A cart of
 * ₹355.22 was displayed as "₹355" on the storefront while the receipt for the same booking
 * said "₹355.22" — the platform showed a number nobody was being charged.
 *
 * So: paise appear exactly when there are paise. ₹799 stays ₹799 and the listing stays
 * clean; ₹355.22 says ₹355.22 and the storefront stops disagreeing with the receipt.
 *
 * Every other currency keeps its own sub-unit unconditionally — $9.99 and $10.00 must not
 * both collapse to "$10" in a table of fee bands where the whole point is telling them apart.
 */
function defaultFractionDigits(minor: number, currency: string, locale: string): number {
  const currencyDigits = currencyFractionDigits(currency, locale);
  if (currency !== 'INR') return currencyDigits;
  return minor % 10 ** currencyDigits === 0 ? 0 : currencyDigits;
}

/**
 * Digits for a whole DOCUMENT of amounts — a price breakdown, a receipt, an invoice.
 *
 * A column of figures has to read as a column. Deciding per amount would print
 *
 *     Tickets       ₹300
 *     Platform fee  ₹55.22
 *
 * where the decimal points do not line up and the first row looks like a different kind of
 * number from the second. Pass every amount the document will show; if any of them has
 * paise, they all get paise.
 *
 * Only INR has anything to decide — every other currency already prints its sub-unit always.
 */
export function moneyFractionDigits(
  amounts: readonly (number | null | undefined)[],
  currency = 'INR',
  locale?: string,
): number {
  const resolved = locale ?? defaultLocale(currency);
  const currencyDigits = currencyFractionDigits(currency, resolved);
  if (currency !== 'INR') return currencyDigits;
  const anyPaise = amounts.some((a) => a != null && a % 10 ** currencyDigits !== 0);
  return anyPaise ? currencyDigits : 0;
}

/**
 * Format an integer minor-unit amount as currency.
 *
 * `fractionDigits` overrides the per-amount rule, and is how a document keeps its column
 * consistent — see `moneyFractionDigits`. Left off, a lone amount decides for itself.
 *
 * This is THE money formatter. It used to be one of five: the storefront said ₹355, the
 * receipt said ₹355.22, the emails grouped as ₹1,04,040 while the receipt grouped as
 * ₹104,040, and two organizer screens had their own again. The comment at the top of this
 * file already warned that a second implementation "is exactly the kind of thing that
 * drifts silently" — it was right, and there were four of them.
 */
export function money(
  minor: number | null | undefined,
  currency = 'INR',
  locale?: string,
  fractionDigits?: number,
): string {
  if (minor == null) return '—';
  const resolved = locale ?? defaultLocale(currency);
  const digits = fractionDigits ?? defaultFractionDigits(minor, currency, resolved);
  try {
    /*
      Scaled by the currency's OWN exponent, not by a hardcoded 100. A minor unit of JPY is
      a yen, so 104040 minor units is ¥104,040 — dividing by 100 makes it ¥1,040, wrong by
      two orders of magnitude rather than merely mis-punctuated.

      This is what the receipt did and this function did not, which is the same defect as
      the decimals in a different digit. INR and USD both have an exponent of 2, so nothing
      the platform currently sells changes.
    */
    const exponent = currencyFractionDigits(currency, resolved);
    return new Intl.NumberFormat(resolved, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minor / 10 ** exponent);
  } catch {
    // An unknown currency code. Show the amount rather than throwing inside a render.
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
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

/**
 * The short name of a timezone at a given instant — "IST", "GMT+5:30", "CDT".
 *
 * Used beside a showtime. A time without its zone is exactly the ambiguity that let a
 * ticket and its confirmation email disagree by eleven and a half hours while both were
 * technically correct: one rendered in the reader's browser zone, the other in the venue's.
 *
 * Returns the raw zone name if the runtime cannot resolve it, and an empty string for no
 * zone at all — never a wrong abbreviation.
 */
export function zoneAbbrev(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value || !timeZone) return '';
  try {
    return (
      new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
        .formatToParts(new Date(value))
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
    );
  } catch {
    return timeZone;
  }
}

/**
 * Just the symbol for a currency — "₹", "$", "C$".
 *
 * For labelling an input the buyer or organizer is typing a bare number into. A field
 * labelled "Price (₹)" on a show in Idaho is not a cosmetic slip: it tells the organizer
 * they are pricing in rupees when the server will store dollars, and they will enter a
 * number meaning one thing and get another.
 *
 * Derived from `Intl` rather than a hand-kept table, so it is right for currencies nobody
 * has thought about here — and falls back to the code itself, which is never wrong, only
 * less pretty.
 */
export function currencySymbol(currency = 'INR', locale?: string): string {
  try {
    const parts = new Intl.NumberFormat(locale ?? defaultLocale(currency), {
      style: 'currency',
      currency,
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}
