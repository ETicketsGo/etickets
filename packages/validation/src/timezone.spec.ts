import { describe, it, expect } from 'vitest';
import { DEFAULT_CINEMA_TIMEZONE, ianaTimeZoneSchema, isValidIanaTimeZone } from './common';

/**
 * Timezone validation.
 *
 * These matter more than they look. An unresolvable zone stored on a cinema does not fail at
 * write time — it fails at every read, when some `Intl.DateTimeFormat` throws while rendering
 * a schedule. Refusing at the edge turns a mystery outage into a rejected form field.
 */
describe('isValidIanaTimeZone', () => {
  it('accepts real IANA names across continents', () => {
    // Deliberately not all India: the point of this work is that the platform is generic.
    for (const tz of [
      'Asia/Kolkata',
      'Europe/London',
      'America/Boise',
      'Australia/Sydney',
      'America/New_York',
      'Africa/Lagos',
      'UTC',
    ]) {
      expect(isValidIanaTimeZone(tz)).toBe(true);
    }
  });

  it('rejects names the runtime cannot resolve', () => {
    for (const tz of ['Not/AZone', 'Asia/Kolkatta', 'Mars/Olympus', 'kolkata']) {
      expect(isValidIanaTimeZone(tz)).toBe(false);
    }
  });

  it('rejects fixed offsets, which cannot follow daylight saving', () => {
    /*
      These look equivalent to a zone and are not. A venue stored as "UTC+5:30" is correct in
      India year-round by luck, and silently an hour out twice a year anywhere that observes
      DST — which is exactly the class of bug this whole change exists to remove.
    */
    for (const tz of ['UTC+5:30', 'UTC-8', 'UTC+00:00']) {
      expect(isValidIanaTimeZone(tz)).toBe(false);
    }
  });

  it('rejects empty and whitespace', () => {
    expect(isValidIanaTimeZone('')).toBe(false);
    expect(isValidIanaTimeZone('Asia/ Kolkata')).toBe(false);
  });
});

describe('ianaTimeZoneSchema', () => {
  it('parses a valid zone', () => {
    expect(ianaTimeZoneSchema.parse('Australia/Sydney')).toBe('Australia/Sydney');
  });

  it('trims incidental whitespace rather than rejecting it', () => {
    expect(ianaTimeZoneSchema.parse('  Europe/London  ')).toBe('Europe/London');
  });

  it('refuses an unknown zone with a message that names the format', () => {
    const result = ianaTimeZoneSchema.safeParse('Middle/Earth');
    expect(result.success).toBe(false);
    if (!result.success) {
      // The operator has to be able to act on this without reading the source.
      expect(result.error.issues[0].message).toMatch(/IANA/);
      expect(result.error.issues[0].message).toMatch(/Asia\/Kolkata|Australia\/Sydney/);
    }
  });

  it('explains why a fixed offset is refused', () => {
    const result = ianaTimeZoneSchema.safeParse('UTC+5:30');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/daylight saving/i);
    }
  });
});

describe('DEFAULT_CINEMA_TIMEZONE', () => {
  it('is the launch market, and is itself valid', () => {
    expect(DEFAULT_CINEMA_TIMEZONE).toBe('Asia/Kolkata');
    expect(isValidIanaTimeZone(DEFAULT_CINEMA_TIMEZONE)).toBe(true);
  });
});
