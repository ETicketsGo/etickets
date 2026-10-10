import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  calendarDisplayStatus,
  calendarFocusTarget,
  calendarStatusText,
  calendarStatusTone,
  calendarWeekdayNames,
} from './calendar-status';
import {
  CalendarDayCard,
  CalendarDayPanel,
  CalendarMonthGrid,
  CalendarRow,
  type CalendarEntry,
} from './calendar-view';

/**
 * The shared calendar presentation both consoles draw with.
 *
 * Entries are built here the way the apps build them: from a FIXED instant, formatted on the
 * venue's clock in the venue's zone. So a 13:30Z show in Kolkata is "19:00" and sits on the
 * Kolkata date, and a 02:00Z show in Denver sits on the Denver date - the day BEFORE its UTC
 * date. The components must draw what they are given and decide nothing about zones.
 */

function venueClock(iso: string, zone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function entry(
  id: string,
  iso: string,
  zone: string,
  over: Partial<CalendarEntry<string>> = {},
): { day: string; entry: CalendarEntry<string> } {
  const { day, time } = venueClock(iso, zone);
  return {
    day,
    entry: {
      id,
      title: `Show ${id}`,
      start: time,
      time: `${time} ${zone}`,
      detail: 'Main Hall, Hyderabad',
      tone: 'success',
      statusLabel: 'Published',
      label: `${time} ${zone}, Show ${id}. Published`,
      source: id,
      ...over,
    },
  };
}

function byDay(list: { day: string; entry: CalendarEntry<string> }[]) {
  const map = new Map<string, CalendarEntry<string>[]>();
  for (const { day, entry: e } of list) map.set(day, [...(map.get(day) ?? []), e]);
  return map;
}

const noop = () => {};
const NOUN = { one: 'session', many: 'sessions' };

/** November 2026 from Monday 26 Oct, as the apps' `monthGrid` lays it out. */
function november(): string[][] {
  const weeks: string[][] = [];
  let d = new Date('2026-10-26T00:00:00Z');
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86_400_000);
    }
    weeks.push(week);
  }
  return weeks;
}

function month(entries: Map<string, CalendarEntry<string>[]>, focusedDay = '2026-11-06') {
  return renderToStaticMarkup(
    createElement(CalendarMonthGrid<string>, {
      weeks: november(),
      month: '2026-11',
      entries,
      today: '2026-11-10',
      focusedDay,
      weekStart: 1,
      formatDay: (d: string) => d,
      noun: NOUN,
      showDayLabel: 'Open the day',
      onFocusDay: noop,
      onOpen: noop,
      onShowDay: noop,
    }),
  );
}

/** The markup of one day cell. */
function cell(html: string, day: string): string {
  const start = html.indexOf(`data-day="${day}"`);
  const open = html.lastIndexOf('<div', start);
  const next = html.indexOf('role="gridcell"', start);
  return html.slice(open, next === -1 ? undefined : next);
}

describe('CalendarMonthGrid', () => {
  const kolkata = entry('k', '2026-11-06T13:30:00.000Z', 'Asia/Kolkata');
  const denver = entry('d', '2026-11-07T02:00:00.000Z', 'America/Denver');

  it('puts each show on the date at its venue, at the venue time it is given', () => {
    expect(kolkata.day).toBe('2026-11-06');
    expect(kolkata.entry.start).toBe('19:00');
    // 02:00 UTC on the 7th is 19:00 on the 6th in Denver.
    expect(denver.day).toBe('2026-11-06');
    const html = month(byDay([kolkata, denver]));
    const sixth = cell(html, '2026-11-06');
    expect(sixth).toContain('data-session-id="k"');
    expect(sixth).toContain('data-session-id="d"');
    expect(cell(html, '2026-11-07')).not.toContain('data-session-id');
    expect(sixth).toContain('aria-label="2026-11-06, 2 sessions"');
  });

  it('marks exactly one cell as today, and only the focused day is in the tab order', () => {
    const html = month(byDay([kolkata]));
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(cell(html, '2026-11-10')).toContain('aria-current="date"');
    // One roving tab stop among the 42 cells.
    expect(html.match(/role="gridcell"[^>]*tabindex="0"/g) ?? []).toHaveLength(1);
    expect(cell(html, '2026-11-06')).toContain('tabindex="0"');
    // A chip in an unfocused day is not a tab stop.
    const other = month(byDay([kolkata]), '2026-11-02');
    expect(cell(other, '2026-11-06')).toMatch(/tabindex="-1"[^>]*data-session-id="k"/);
    expect(cell(html, '2026-11-06')).toMatch(/tabindex="0"[^>]*data-session-id="k"/);
  });

  it('caps a busy day at three chips and says how many more', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      entry(`m${i}`, `2026-11-12T0${i}:00:00.000Z`, 'UTC'),
    );
    const day = cell(month(byDay(many)), '2026-11-12');
    expect(day.match(/data-session-id=/g)).toHaveLength(3);
    expect(day).toContain('+2 more');
    expect(day).toContain('2 more on 2026-11-12. Open the day');
  });

  it('heads the columns from the week start', () => {
    expect(calendarWeekdayNames(1)[0]).toBe('Mon');
    expect(calendarWeekdayNames(0)[0]).toBe('Sun');
    expect(month(new Map()).indexOf('>Mon<')).toBeLessThan(month(new Map()).indexOf('>Sun<'));
  });
});

describe('CalendarRow, CalendarDayPanel and CalendarDayCard', () => {
  const long = entry('l', '2026-11-06T13:30:00.000Z', 'Asia/Kolkata', {
    title: 'A very long festival title that would never fit a narrow phone row in one line',
    statusLabel: 'Session cancelled',
    tone: 'error',
    struck: true,
  });

  it('prints the whole title and the status in words - nothing in a row is cut off', () => {
    const html = renderToStaticMarkup(
      createElement(CalendarRow<string>, { entry: long.entry, onOpen: noop }),
    );
    expect(html).toContain(long.entry.title);
    expect(html).toContain('Session cancelled');
    expect(html).toContain('line-through');
    expect(html).not.toContain('truncate');
  });

  it('lists the chosen day beside the month, with today marked and a cap', () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      entry(`p${i}`, `2026-11-10T0${i}:00:00.000Z`, 'UTC'),
    );
    const html = renderToStaticMarkup(
      createElement(CalendarDayPanel<string>, {
        day: '2026-11-10',
        heading: 'Tue, 10 Nov 2026',
        entries: ten.map((t) => t.entry),
        today: '2026-11-10',
        noun: NOUN,
        showDayLabel: 'Open the day',
        onOpen: noop,
        onShowDay: noop,
      }),
    );
    expect(html).toContain('Tue, 10 Nov 2026');
    expect(html).toContain('Today');
    expect(html).toContain('10 sessions, at venue time');
    expect(html.match(/data-session-id=/g)).toHaveLength(8);
    expect(html).toContain('2 more on this day');
  });

  it('a day card lists every row once expanded, and says when a day is empty', () => {
    const three = Array.from({ length: 3 }, (_, i) =>
      entry(`c${i}`, `2026-11-10T0${i}:00:00.000Z`, 'UTC'),
    );
    const props = {
      day: '2026-11-10',
      heading: 'Tue 10 Nov',
      entries: three.map((t) => t.entry),
      today: '2026-11-01',
      noun: { one: 'show', many: 'shows' },
      onOpen: noop,
      cap: 2,
      onExpand: noop,
    };
    const capped = renderToStaticMarkup(createElement(CalendarDayCard<string>, props));
    expect(capped.match(/data-session-id=/g)).toHaveLength(2);
    expect(capped).toContain('Show 1 more on Tue 10 Nov');
    const open = renderToStaticMarkup(
      createElement(CalendarDayCard<string>, { ...props, expanded: true }),
    );
    expect(open.match(/data-session-id=/g)).toHaveLength(3);
    const empty = renderToStaticMarkup(
      createElement(CalendarDayCard<string>, { ...props, entries: [] }),
    );
    expect(empty).toContain('No shows');
    expect(empty).toContain('0 shows');
  });
});

describe('the shared status table', () => {
  it('speaks the lifecycle vocabulary, and an unknown status is neutral', () => {
    expect(calendarStatusText('UNDER_REVIEW')).toBe('In review');
    expect(calendarStatusText('COMPLETED')).toBe('Ended');
    expect(calendarStatusText('SOME_NEW_STATE')).toBe('Some new state');
    expect(calendarStatusTone('PUBLISHED')).toBe('success');
    expect(calendarStatusTone('SOME_NEW_STATE')).toBe('neutral');
  });

  it("draws a cancelled session inside a published event as cancelled, in each console's word", () => {
    expect(calendarDisplayStatus('PUBLISHED', 'CANCELLED', 'Session')).toEqual({
      status: 'CANCELLED',
      label: 'Session cancelled',
    });
    expect(calendarDisplayStatus('PUBLISHED', 'PAUSED', 'Show').label).toBe('Show paused');
    expect(calendarDisplayStatus('DRAFT', 'SCHEDULED', 'Show')).toEqual({
      status: 'DRAFT',
      label: 'Draft',
    });
  });

  it('moves keyboard focus by day, week and to the ends of the week', () => {
    expect(calendarFocusTarget('2026-11-01', 'ArrowLeft', 1)).toBe('2026-10-31');
    expect(calendarFocusTarget('2026-11-06', 'ArrowDown', 1)).toBe('2026-11-13');
    // Friday 6 Nov: a Monday week runs 2-8, a Sunday week 1-7.
    expect(calendarFocusTarget('2026-11-06', 'Home', 1)).toBe('2026-11-02');
    expect(calendarFocusTarget('2026-11-06', 'End', 0)).toBe('2026-11-07');
    expect(calendarFocusTarget('2026-11-06', 'a', 1)).toBeNull();
  });
});
