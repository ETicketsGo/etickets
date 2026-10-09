import { describe, expect, it } from 'vitest';
import { instantToWallClock, venueInputZone, wallClockToInstant } from './zoned-time';

describe('show times are typed in the venue zone', () => {
  it('reads 19:00 at a Hyderabad venue as 19:00 IST, whatever zone the browser is in', () => {
    // The QA defect: this used to become 02:00Z the next day from a browser in Denver.
    expect(wallClockToInstant('2026-11-06T19:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-06T13:30:00.000Z',
    );
  });

  it('reads 18:00 at a Toronto venue in Toronto time, on both sides of the DST change', () => {
    expect(wallClockToInstant('2026-10-30T18:00', 'America/Toronto').toISOString()).toBe(
      '2026-10-30T22:00:00.000Z',
    );
    expect(wallClockToInstant('2026-11-06T18:00', 'America/Toronto').toISOString()).toBe(
      '2026-11-06T23:00:00.000Z',
    );
  });

  it('round-trips for an edit form', () => {
    for (const [local, zone] of [
      ['2026-11-06T19:00', 'Asia/Kolkata'],
      ['2026-03-08T03:30', 'America/New_York'],
      ['2026-12-31T23:45', 'Pacific/Auckland'],
    ] as const) {
      expect(instantToWallClock(wallClockToInstant(local, zone), zone)).toBe(local);
    }
  });

  it("uses the venue's zone, else its country's only zone, else says it does not know", () => {
    expect(venueInputZone({ timezone: 'America/Toronto', country: 'CA' })).toEqual({
      zone: 'America/Toronto',
      known: true,
    });
    expect(venueInputZone({ timezone: null, country: 'India' })).toEqual({
      zone: 'Asia/Kolkata',
      known: true,
    });
    expect(venueInputZone({ timezone: null, country: 'US' }).known).toBe(false);
  });
});
