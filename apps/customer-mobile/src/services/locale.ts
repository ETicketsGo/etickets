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
  return money(minor, currency, deviceLocale.tag);
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
