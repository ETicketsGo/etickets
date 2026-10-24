import * as Localization from 'expo-localization';
import { money, dateOnly, dateTime } from '@eticketsgo/shared-types';

/**
 * Device locale, region and the formatters bound to them.
 *
 * WHAT THIS DOES NOT DO: choose a currency to charge in. An event's currency comes from
 * the API and belongs to the event, not the viewer — a Canadian buying an Indian event's
 * ticket pays INR, and showing that price as "CA$1,299" because the phone is set to
 * Canada would be a lie about what the card will be debited. The region here only picks
 * the *default* discovery market and the digit/date conventions used to render whatever
 * currency the backend sends.
 */

/** Markets the product ships in. Anything else falls back to US conventions. */
export const SUPPORTED_REGIONS = ['IN', 'US', 'CA'] as const;
export type Region = (typeof SUPPORTED_REGIONS)[number];

function detectRegion(): Region {
  const code = Localization.getLocales()[0]?.regionCode?.toUpperCase();
  return (SUPPORTED_REGIONS as readonly string[]).includes(code ?? '') ? (code as Region) : 'US';
}

function detectLocale(): string {
  // languageTag is a full BCP-47 tag ("en-IN"), which is what Intl wants.
  return Localization.getLocales()[0]?.languageTag ?? 'en-US';
}

function detectTimeZone(): string {
  return Localization.getCalendars()[0]?.timeZone ?? 'UTC';
}

/**
 * Resolved once at module load. Changing the phone's language restarts the JS bundle on
 * both platforms, so there is no live-update case to handle, and re-reading it on every
 * render would put a native bridge call in the render path of every price on screen.
 */
export const deviceLocale = {
  region: detectRegion(),
  tag: detectLocale(),
  timeZone: detectTimeZone(),
};

/** The market's default currency — used only where nothing else specifies one. */
export const REGION_CURRENCY: Record<Region, string> = { IN: 'INR', US: 'USD', CA: 'CAD' };

/** Format an integer minor-unit amount in the currency the API supplied. */
export function formatMoney(minor: number | null | undefined, currency: string): string {
  // The CURRENCY picks the conventions, exactly as on the website (shared-types `money`):
  // a rupee price prints "Rs 1,499" with Indian grouping and no ".00" on whole rupees, a
  // dollar price "$35.00", whoever is looking. Passing the phone's locale here printed
  // "US$35.00" on an English (UK) phone, and an Indian price differently from the site.
  return money(minor, currency);
}

/**
 * Format an event time. `timeZone` should be the VENUE's zone when the API provides one:
 * a 7pm show in Mumbai is 7pm for everyone holding a ticket to it, and rendering it in
 * the phone's zone would tell a traveller the wrong start time.
 */
export function formatDateTime(value: string | Date | null | undefined, timeZone?: string): string {
  return dateTime(value, deviceLocale.tag, timeZone);
}

export function formatDate(value: string | Date | null | undefined, timeZone?: string): string {
  return dateOnly(value, deviceLocale.tag, timeZone);
}

function parts(
  value: string | Date,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string,
): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  try {
    return date.toLocaleString(deviceLocale.tag, { ...options, timeZone });
  } catch {
    // An unknown zone name throws a RangeError; the device's zone beats nothing.
    return date.toLocaleString(deviceLocale.tag, options);
  }
}

/**
 * The storefront's short date: "Sat 14 Nov". In the VENUE's zone, as every event time is.
 */
export function formatShortDate(value: string | Date, timeZone?: string): string {
  return parts(value, { weekday: 'short', day: 'numeric', month: 'short' }, timeZone).replace(
    ',',
    '',
  );
}

/**
 * The storefront's time: "9:00 pm". Twelve-hour with a lower-case suffix, as the website
 * prints it, whatever the phone's own clock setting, so a ticket reads the same on both.
 */
export function formatShortTime(value: string | Date, timeZone?: string): string {
  return parts(value, { hour: 'numeric', minute: '2-digit', hour12: true }, timeZone)
    .replace(/\s?([AP])\.?M\.?/i, (_m, ap: string) => ` ${ap.toLowerCase()}m`)
    .trim();
}

/** "Sat 14 Nov, 9:00 pm": the line under an event title on the storefront. */
export function formatEventWhen(value: string | Date, timeZone?: string): string {
  return `${formatShortDate(value, timeZone)}, ${formatShortTime(value, timeZone)}`;
}
