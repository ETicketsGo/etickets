import { describe, expect, it } from 'vitest';
import { unambiguousZoneFor, venueZone } from './markets';

describe('the zone a venue runs in', () => {
  it('is the only zone a single-zone country has, in any stored spelling', () => {
    expect(unambiguousZoneFor('IN')).toBe('Asia/Kolkata');
    expect(unambiguousZoneFor('India')).toBe('Asia/Kolkata');
    expect(unambiguousZoneFor('india')).toBe('Asia/Kolkata');
    expect(unambiguousZoneFor('UK')).toBe('Europe/London');
  });

  it('is never guessed for a country with several zones, or an unknown one', () => {
    expect(unambiguousZoneFor('US')).toBeNull();
    expect(unambiguousZoneFor('Canada')).toBeNull();
    expect(unambiguousZoneFor('AU')).toBeNull();
    expect(unambiguousZoneFor('Atlantis')).toBeNull();
    expect(unambiguousZoneFor(null)).toBeNull();
  });

  it('prefers the zone the venue was given over its country', () => {
    expect(venueZone('Asia/Dubai', 'IN')).toBe('Asia/Dubai');
    expect(venueZone(null, 'IN')).toBe('Asia/Kolkata');
    expect(venueZone('  ', 'IN')).toBe('Asia/Kolkata');
    expect(venueZone(null, 'US')).toBeNull();
  });
});
