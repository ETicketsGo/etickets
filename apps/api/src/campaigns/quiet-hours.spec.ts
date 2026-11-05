import {
  DEFAULT_QUIET_HOURS,
  isQuietTime,
  isValidTimeZone,
  localMinuteOfDay,
  nextSendableTime,
  quietHoursProblem,
} from './quiet-hours';

describe('quiet hours', () => {
  const Q = DEFAULT_QUIET_HOURS; // 21:00 - 08:00

  it('reads the local wall clock of the zone', () => {
    // 15:30 UTC is 21:00 in Kolkata (UTC+5:30).
    expect(localMinuteOfDay(new Date('2026-10-27T15:30:00Z'), 'Asia/Kolkata')).toBe(21 * 60);
  });

  it.each([
    ['2026-10-27T15:29:00Z', 'Asia/Kolkata', false], // 20:59 IST
    ['2026-10-27T15:30:00Z', 'Asia/Kolkata', true], // 21:00 IST, start is inclusive
    ['2026-10-27T20:00:00Z', 'Asia/Kolkata', true], // 01:30 IST
    ['2026-10-28T02:29:00Z', 'Asia/Kolkata', true], // 07:59 IST
    ['2026-10-28T02:30:00Z', 'Asia/Kolkata', false], // 08:00 IST, end is exclusive
    ['2026-10-27T12:00:00Z', 'America/New_York', false], // 08:00 EDT
    ['2026-10-28T02:00:00Z', 'America/New_York', true], // 22:00 EDT
  ])('%s in %s is quiet: %s', (iso, zone, quiet) => {
    expect(isQuietTime(new Date(iso), zone, Q)).toBe(quiet);
  });

  it('a window that does not cross midnight', () => {
    const lunch = { start: '12:00', end: '13:00' };
    expect(isQuietTime(new Date('2026-10-27T12:30:00Z'), 'UTC', lunch)).toBe(true);
    expect(isQuietTime(new Date('2026-10-27T13:00:00Z'), 'UTC', lunch)).toBe(false);
  });

  it('no quiet hours means never quiet', () => {
    expect(isQuietTime(new Date(), 'UTC', null)).toBe(false);
  });

  it('the next sendable time is the end of the quiet period, in the zone', () => {
    const at = new Date('2026-10-27T17:00:00Z'); // 22:30 IST
    expect(nextSendableTime(at, 'Asia/Kolkata', Q).toISOString()).toBe('2026-10-28T02:30:00.000Z');
  });

  it('is right across a DST change (New York, 1 Nov 2026)', () => {
    // 23:00 EDT on 31 Oct; the clocks go back at 02:00, so 08:00 EST is 13:00 UTC.
    const at = new Date('2026-11-01T03:00:00Z');
    expect(nextSendableTime(at, 'America/New_York', Q).toISOString()).toBe(
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('outside quiet hours, now is fine', () => {
    const at = new Date('2026-10-27T06:00:00Z'); // 11:30 IST
    expect(nextSendableTime(at, 'Asia/Kolkata', Q)).toBe(at);
  });

  it('validates the setting and the zone', () => {
    expect(quietHoursProblem({ start: '21:00', end: '08:00' })).toBeNull();
    expect(quietHoursProblem({ start: '9pm', end: '08:00' })).toMatch(/start and an end/);
    expect(quietHoursProblem({ start: '08:00', end: '08:00' })).toMatch(/differ/);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
