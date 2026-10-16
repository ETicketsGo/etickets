import { describe, expect, it } from 'vitest';
import { recordedAt, timeAtVenue } from './format';

/*
  QA 2026-10-16, on a machine set to Mountain time: a 7:00 pm Bengaluru show read
  "20 Nov 2026, 6:30 am" on the bookings search and in the check-in device list. A show time is
  the VENUE's clock, named; a recorded time is the reader's clock, named.
*/
const SHOW = '2026-11-20T13:30:00.000Z'; // 7:00 pm in Bengaluru, 6:30 am in Denver

describe('timeAtVenue', () => {
  it('reads a Bengaluru show on the Bengaluru clock, named, whatever the reader clock', () => {
    expect(timeAtVenue(SHOW, { timezone: 'Asia/Kolkata', country: 'IN' })).toMatch(
      /^20 Nov 2026, 7:00\s?pm IST$/i,
    );
    // A venue never given a zone, in a one-zone country: the country is the answer.
    expect(timeAtVenue(SHOW, { timezone: null, country: 'India' })).toMatch(/7:00\s?pm IST$/i);
    // The zone on its own, as the bookings search sends it.
    expect(timeAtVenue(SHOW, 'Asia/Kolkata')).toMatch(/7:00\s?pm IST$/i);
  });

  it('says the time is the reader own when the venue zone is not known', () => {
    expect(timeAtVenue(SHOW, { timezone: null, country: 'US' })).toMatch(/\(your time\)$/);
    expect(timeAtVenue(SHOW, null)).toMatch(/\(your time\)$/);
  });

  it('is a dash, not a crash, for no time at all', () => {
    expect(timeAtVenue(null, 'Asia/Kolkata')).toBe('-');
  });
});

describe('recordedAt', () => {
  it('reads on the reader clock and names it', () => {
    expect(recordedAt(SHOW, 'America/Denver')).toMatch(/^20 Nov 2026, 6:30\s?am MST$/i);
  });

  it('is a dash for nothing recorded', () => {
    expect(recordedAt(undefined)).toBe('-');
  });
});
