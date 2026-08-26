import { describe as vitestDescribe, expect, it } from 'vitest';
import { addDays, addHours, describe as describeValue, join, split } from './datetime-value';

/**
 * The arithmetic behind the date/time picker.
 *
 * Worth its own tests because every bug this code can have is silent: an event that reads
 * back as the previous evening, an end time before its start, a 7:15 doors time quietly
 * rounded to 7:30 the next time somebody opens the form. None of those throw.
 */
vitestDescribe('datetime value arithmetic', () => {
  vitestDescribe('split and join round-trip', () => {
    it('keeps a value byte-identical through a split and a join', () => {
      const value = '2026-08-30T19:00';
      const { date, time } = split(value);
      expect(join(date, time)).toBe(value);
    });

    it('drops seconds, which nothing schedules on', () => {
      expect(split('2026-08-30T19:00:00').time).toBe('19:00');
    });

    it('survives the half-filled states a form passes through', () => {
      expect(split('')).toEqual({ date: '', time: '' });
      expect(split('2026-08-30')).toEqual({ date: '2026-08-30', time: '' });
      expect(join('', '')).toBe('');
    });
  });

  vitestDescribe('describe', () => {
    it('reads the value back as a sentence a human would say', () => {
      expect(describeValue('2026-08-30T19:00')).toBe('Sun 30 Aug 2026, 7:00 PM');
    });

    it('says midnight and midday the way people do, not as 0:00 and 12:00', () => {
      // The classic off-by-twelve: `hour % 12` alone renders both as "0".
      expect(describeValue('2026-08-30T00:00')).toContain('12:00 AM');
      expect(describeValue('2026-08-30T12:00')).toContain('12:00 PM');
    });

    it('does not shift the day, which is the whole reason no string is parsed', () => {
      // `new Date('2026-01-01T00:30')` is parsed as UTC on some paths; rendered back in a
      // timezone behind UTC it becomes 31 December. This is that regression, pinned.
      expect(describeValue('2026-01-01T00:30')).toContain('1 Jan 2026');
      expect(describeValue('2026-12-31T23:30')).toContain('31 Dec 2026');
    });

    it('stays silent while the value is incomplete', () => {
      // A half-typed year must not render as a confident wrong date.
      expect(describeValue('2026-08-30')).toBeNull();
      expect(describeValue('202-08-30T19:00')).toBeNull();
      expect(describeValue('')).toBeNull();
    });
  });

  vitestDescribe('addDays', () => {
    it('rolls into the next month', () => {
      expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    });

    it('rolls into the next year', () => {
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('handles a leap day', () => {
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    });

    it('pads single-digit months and days, since the value is compared as a string', () => {
      // "2026-9-1" would sort wrong and would be rejected by the date input outright.
      expect(addDays('2026-08-31', 1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  vitestDescribe('addHours', () => {
    it('adds whole hours to a showtime', () => {
      expect(addHours('19:00', 2)).toBe('21:00');
    });

    it('keeps the minutes of an odd start time', () => {
      expect(addHours('19:15', 2)).toBe('21:15');
    });

    it('refuses to cross midnight instead of wrapping', () => {
      /*
        The bug this prevents. Wrapping 23:00 + 2h to 01:00 keeps the SAME date, producing a
        session that ends two hours before it began — which validation would reject with a
        confusing message, if it caught it at all. Refusing means the shortcut simply is not
        offered, and the organizer sets the end time themselves.
      */
      expect(addHours('23:00', 2)).toBeNull();
      expect(addHours('22:00', 2)).toBeNull();
    });

    it('allows an end exactly at the last half hour of the day', () => {
      expect(addHours('21:30', 2)).toBe('23:30');
    });
  });
});
