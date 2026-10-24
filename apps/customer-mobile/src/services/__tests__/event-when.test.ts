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

  it('survives an unknown zone name', () => {
    expect(() => formatEventWhen(iso, 'Not/AZone')).not.toThrow();
  });
});
