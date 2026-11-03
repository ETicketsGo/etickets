/**
 * The reader's time zone, mirrored by the browser so the server renders times exactly as the
 * browser will (see `lib/reader-zone.tsx`). Display only - never used to price or schedule.
 */
export const READER_ZONE_COOKIE = 'etg_tz';

/** A cookie value that names a real IANA zone, or undefined. */
export function validZone(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  let zone = value;
  try {
    zone = decodeURIComponent(value);
  } catch {
    /* keep the raw value */
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}
