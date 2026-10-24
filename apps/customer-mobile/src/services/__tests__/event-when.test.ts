import { formatEventWhen, formatShortDate, formatShortTime } from '../locale';

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-GB', regionCode: 'US' }],
  getCalendars: () => [{ timeZone: 'America/Denver' }],
}));

/** 15 Nov 2026 05:00 UTC is 10:30 in Bengaluru and 22:00 the day before in Denver. */
const iso = '2026-11-15T05:00:00.000Z';

describe('storefront date line', () => {
  it('prints the venue date and a 12-hour lower-case time, as the website does', () => {
    expect(formatShortDate(iso, 'Asia/Kolkata')).toBe('Sun 15 Nov');
    expect(formatShortTime(iso, 'Asia/Kolkata')).toBe('10:30 am');
    expect(formatEventWhen(iso, 'Asia/Kolkata')).toBe('Sun 15 Nov, 10:30 am');
  });

  it('keeps the storefront order on a US-English phone', () => {
    // en-US formats "Sun, Nov 15"; the date must still read "Sun 15 Nov".
    jest.isolateModules(() => {
      jest.doMock('expo-localization', () => ({
        getLocales: () => [{ languageTag: 'en-US', regionCode: 'US' }],
        getCalendars: () => [{ timeZone: 'America/Denver' }],
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const us = require('../locale') as typeof import('../locale');
      expect(us.formatShortDate(iso, 'Asia/Kolkata')).toBe('Sun 15 Nov');
      expect(us.dateParts(iso, 'Asia/Kolkata')).toEqual({
        weekday: 'Sun',
        day: '15',
        month: 'Nov',
      });
    });
  });

  it('survives an unknown zone name', () => {
    expect(() => formatEventWhen(iso, 'Not/AZone')).not.toThrow();
  });
});
