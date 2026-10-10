import { describe, expect, it } from 'vitest';
import {
  monthCells,
  monthRange,
  monthTitle,
  sessionsByDay,
  shiftMonth,
  type CalendarSessionLike,
} from './event-calendar-model';

const KOLKATA = { timezone: 'Asia/Kolkata', country: 'IN' };
const CHICAGO = { timezone: 'America/Chicago', country: 'US' };

function session(
  id: string,
  startsAt: string,
  over: Partial<CalendarSessionLike> = {},
): CalendarSessionLike {
  return { id, startsAt, status: 'SCHEDULED', event: { id: `e-${id}` }, venue: KOLKATA, ...over };
}

describe('monthCells', () => {
  it('draws whole weeks from Sunday, and only as many as the month needs', () => {
    // October 2026 starts on a Thursday and has 31 days: 4 lead days + 31 = 35, five rows.
    const oct = monthCells('2026-10');
    expect(oct).toHaveLength(35);
    expect(oct[0]).toEqual({ date: '2026-09-27', day: 27, inMonth: false });
    expect(oct[4]).toEqual({ date: '2026-10-01', day: 1, inMonth: true });
    expect(oct.at(-1)).toEqual({ date: '2026-10-31', day: 31, inMonth: true });
    // August 2026 starts on a Saturday: 6 lead days + 31 = 37, so six rows.
    expect(monthCells('2026-08')).toHaveLength(42);
    // February 2026 starts on a Sunday and has 28 days: exactly four rows.
    expect(monthCells('2026-02')).toHaveLength(28);
  });
});

describe('month navigation', () => {
  it('crosses year boundaries both ways', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthTitle('2026-10')).toBe('October 2026');
  });

  it('asks the API for the month widened by a day each side, inside its 62-day cap', () => {
    const { from, to } = monthRange('2026-10');
    expect(from).toBe('2026-09-30T00:00:00.000Z');
    expect(to).toBe('2026-11-02T00:00:00.000Z');
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThanOrEqual(62);
  });
});

describe('sessionsByDay', () => {
  it('puts a show on its day AT THE VENUE, not in UTC', () => {
    // 1 a.m. on 1 Nov in Kolkata is 31 Oct in UTC; 11 p.m. on 31 Oct in Chicago is 1 Nov UTC.
    const days = sessionsByDay(
      [
        session('kol', '2026-10-31T19:30:00.000Z'),
        session('chi', '2026-11-01T04:00:00.000Z', { venue: CHICAGO }),
      ],
      null,
    );
    expect(days.get('2026-11-01')?.map((s) => s.id)).toEqual(['kol']);
    expect(days.get('2026-10-31')?.map((s) => s.id)).toEqual(['chi']);
  });

  it("uses a seated show's cinema zone over its venue's", () => {
    const days = sessionsByDay(
      [
        session('s', '2026-11-01T04:00:00.000Z', {
          venue: KOLKATA,
          cinemaTimezone: 'America/Chicago',
        }),
      ],
      null,
    );
    expect([...days.keys()]).toEqual(['2026-10-31']);
  });

  it('leaves out cancelled shows and events the other filters dropped, in start order', () => {
    const days = sessionsByDay(
      [
        session('late', '2026-10-13T14:00:00.000Z'),
        session('early', '2026-10-13T04:00:00.000Z'),
        session('gone', '2026-10-13T06:00:00.000Z', { status: 'CANCELLED' }),
        session('other', '2026-10-13T08:00:00.000Z'),
      ],
      new Set(['e-late', 'e-early', 'e-gone']),
    );
    expect(days.get('2026-10-13')?.map((s) => s.id)).toEqual(['early', 'late']);
  });
});
