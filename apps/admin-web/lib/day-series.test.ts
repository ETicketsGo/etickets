import { describe, expect, it } from 'vitest';
import { fillDays } from './day-series';

const zero = (day: string) => ({ day, n: 0 });

describe('fillDays', () => {
  it('puts back the days the API left out, as zero', () => {
    const out = fillDays(
      [
        { day: '2026-10-05', n: 3 },
        { day: '2026-10-01', n: 2 },
      ],
      '2026-10-01',
      '2026-10-05',
      zero,
    );
    expect(out.map((p) => `${p.day}:${p.n}`)).toEqual([
      '2026-10-01:2',
      '2026-10-02:0',
      '2026-10-03:0',
      '2026-10-04:0',
      '2026-10-05:3',
    ]);
  });

  it('never changes a value the API returned, and keeps one outside the window', () => {
    const out = fillDays([{ day: '2026-09-30', n: 7 }], '2026-10-01', '2026-10-02', zero);
    expect(out).toEqual([
      { day: '2026-09-30', n: 7 },
      { day: '2026-10-01', n: 0 },
      { day: '2026-10-02', n: 0 },
    ]);
  });

  it('reads a window given as timestamps', () => {
    const out = fillDays([], '2026-10-01T00:00:00.000Z', '2026-10-03T23:59:59.999Z', zero);
    expect(out.map((p) => p.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('refuses to build an absurd window', () => {
    const series = [{ day: '2026-10-01', n: 1 }];
    expect(fillDays(series, '2000-01-01', '2026-10-01', zero)).toEqual(series);
  });
});
