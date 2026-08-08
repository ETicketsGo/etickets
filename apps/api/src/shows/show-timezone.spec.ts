import { zonedWallClockToInstant } from './shows.service';

/**
 * A theater publishes "10:30", not an offset.
 *
 * The naive `new Date(`${date}T${time}`)` resolves against the SERVER's zone, so a
 * container running in UTC — which every deployment here does — would schedule every
 * Indian show 5h30m late. Nobody notices until a customer arrives for a show that already
 * started.
 */
describe('zonedWallClockToInstant', () => {
  it('reads a wall-clock time in India, not on the server', () => {
    // 10:30 IST is 05:00 UTC.
    expect(zonedWallClockToInstant('2026-08-21', '10:30', 'Asia/Kolkata').toISOString()).toBe(
      '2026-08-21T05:00:00.000Z',
    );
  });

  it('handles the half-hour offset that trips fixed-offset arithmetic', () => {
    expect(zonedWallClockToInstant('2026-08-21', '00:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-08-20T18:30:00.000Z',
    );
  });

  it('keeps a late-night show on the right calendar day', () => {
    // 23:45 IST is 18:15 UTC the SAME day — a naive conversion can roll it over.
    expect(zonedWallClockToInstant('2026-08-21', '23:45', 'Asia/Kolkata').toISOString()).toBe(
      '2026-08-21T18:15:00.000Z',
    );
  });

  it('is identity for UTC', () => {
    expect(zonedWallClockToInstant('2026-08-21', '09:00', 'UTC').toISOString()).toBe(
      '2026-08-21T09:00:00.000Z',
    );
  });

  it('produces the same wall-clock time on every date of a run', () => {
    const times = ['2026-08-21', '2026-08-22', '2026-08-23'].map((d) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(zonedWallClockToInstant(d, '20:15', 'Asia/Kolkata')),
    );
    expect(times).toEqual(['20:15', '20:15', '20:15']);
  });

  it('stays correct across a DST transition in a zone that observes one', () => {
    // India does not observe DST, so this uses a market that does. A fixed-offset
    // implementation gets one of these two wrong.
    const before = zonedWallClockToInstant('2026-03-07', '10:00', 'America/New_York');
    const after = zonedWallClockToInstant('2026-03-14', '10:00', 'America/New_York');
    expect(before.toISOString()).toBe('2026-03-07T15:00:00.000Z'); // EST, UTC-5
    expect(after.toISOString()).toBe('2026-03-14T14:00:00.000Z'); // EDT, UTC-4
  });
});
