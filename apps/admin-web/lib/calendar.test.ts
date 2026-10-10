import { describe, expect, it } from 'vitest';
import {
  addDays,
  entriesByDay,
  cityOptions,
  fetchWindow,
  inCity,
  localDay,
  localTime,
  parseDay,
  parseView,
  placeSessions,
  rangeLabel,
  shiftAnchor,
  showStatus,
  statusText,
  statusTone,
  toWeeks,
  viewDays,
  zoneNote,
  zoneUnknown,
} from './calendar';

function session(id: string, startsAt: string, timezone: string | null, title = id) {
  return { id, startsAt, timezone, event: { title } };
}

describe('the days each view draws', () => {
  it('draws a month in whole Monday-to-Sunday weeks', () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const days = viewDays('month', '2026-10-09');
    expect(days[0]).toBe('2026-09-28');
    expect(days[days.length - 1]).toBe('2026-11-01');
    expect(days).toHaveLength(35);
  });

  it('draws a February that starts on a Monday as exactly four weeks', () => {
    const days = viewDays('month', '2027-02-14');
    expect(days[0]).toBe('2027-02-01');
    expect(days).toHaveLength(28);
  });

  it('draws the Monday-to-Sunday week holding the anchor', () => {
    expect(viewDays('week', '2026-10-09')).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
  });

  it('lists fourteen days from the anchor in the agenda', () => {
    const days = viewDays('agenda', '2026-12-25');
    expect(days[0]).toBe('2026-12-25');
    expect(days[13]).toBe('2027-01-07');
  });

  it('never asks the API for more than its 62-day cap, even for the longest month grid', () => {
    // A 31-day month starting on a Sunday needs six rows: 42 days, 44 with padding.
    const days = viewDays('month', '2026-03-01');
    expect(days).toHaveLength(42);
    const { from, to } = fetchWindow(days);
    const span =
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
        86_400_000 +
      1;
    expect(span).toBeLessThanOrEqual(62);
  });
});

describe('moving between periods', () => {
  it('moves a month view to the first of the next and previous month', () => {
    expect(shiftAnchor('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftAnchor('month', '2026-03-31', -1)).toBe('2026-02-01');
  });

  it('moves a week by seven days and the agenda by its length', () => {
    expect(shiftAnchor('week', '2026-10-09', 1)).toBe('2026-10-16');
    expect(shiftAnchor('agenda', '2026-10-09', -1)).toBe('2026-09-25');
  });

  it('crosses a year cleanly', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('the window asked of the API', () => {
  it('pads the drawn days by one UTC day on each side', () => {
    expect(fetchWindow(viewDays('week', '2026-10-09'))).toEqual({
      from: '2026-10-04',
      to: '2026-10-12',
    });
  });
});

describe("a session's day is the day at its venue", () => {
  const days = viewDays('week', '2026-10-09'); // Mon 5 Oct .. Sun 11 Oct

  it('puts a Saturday 00:30 show in Auckland on Saturday, though UTC says Friday', () => {
    const s = session('akl', '2026-10-09T11:30:00.000Z', 'Pacific/Auckland');
    expect(localDay(s.startsAt, s.timezone)).toBe('2026-10-10');
    const { byDay } = placeSessions([s], days);
    expect(byDay['2026-10-10'].map((x) => x.id)).toEqual(['akl']);
    expect(byDay['2026-10-09']).toEqual([]);
  });

  it('puts a Sunday 23:00 show in Los Angeles on Sunday, though UTC says Monday', () => {
    const s = session('lax', '2026-10-12T06:00:00.000Z', 'America/Los_Angeles');
    const { byDay, outside } = placeSessions([s], days);
    expect(byDay['2026-10-11'].map((x) => x.id)).toEqual(['lax']);
    expect(outside).toBe(0);
  });

  it('reads the time on the venue clock, in ASCII', () => {
    expect(localTime('2026-10-09T13:30:00.000Z', 'Asia/Kolkata')).toBe('7:00 PM');
    expect(/^[\x20-\x7e]+$/.test(localTime('2026-10-09T13:30:00.000Z', 'Asia/Kolkata'))).toBe(true);
  });

  it('orders a day by the venue clock, not by the instant', () => {
    // 10:00 in Kolkata is 04:30Z; 09:00 in London (BST) is 08:00Z. By the instant Kolkata is
    // first; by the clock on the wall at each venue London is first.
    const kol = session('kol', '2026-10-07T04:30:00.000Z', 'Asia/Kolkata', 'A');
    const lon = session('lon', '2026-10-07T08:00:00.000Z', 'Europe/London', 'B');
    const { byDay } = placeSessions([kol, lon], days);
    expect(byDay['2026-10-07'].map((x) => x.id)).toEqual(['lon', 'kol']);
  });

  it('places a session with no zone in UTC and says so, rather than guessing India', () => {
    const s = session('nz', '2026-10-09T20:00:00.000Z', null);
    expect(localDay(s.startsAt, s.timezone)).toBe('2026-10-09');
    expect(zoneUnknown(null)).toBe(true);
    expect(zoneNote(s.startsAt, null)).toBe('UTC');
    // An unknown name is treated the same way, not thrown on.
    expect(zoneUnknown('Mars/Olympus')).toBe(true);
    expect(localDay(s.startsAt, 'Mars/Olympus')).toBe('2026-10-09');
  });

  it('names the zone each session is shown in', () => {
    expect(zoneNote('2026-10-09T13:30:00.000Z', 'Asia/Kolkata')).toMatch(/IST|GMT\+5:30/);
  });

  it('drops the padding days and counts what it dropped', () => {
    const before = session('pad', '2026-10-04T10:00:00.000Z', 'Asia/Kolkata');
    const { byDay, outside } = placeSessions([before], days);
    expect(outside).toBe(1);
    expect(Object.values(byDay).flat()).toEqual([]);
  });

  it('gives every drawn day an entry, empty or not', () => {
    const { byDay } = placeSessions([], days);
    expect(Object.keys(byDay)).toEqual(days);
  });
});

describe('labels and parsing', () => {
  it('names the range', () => {
    expect(rangeLabel('month', '2026-10-09', viewDays('month', '2026-10-09'))).toBe('October 2026');
    expect(rangeLabel('week', '2026-10-09', viewDays('week', '2026-10-09'))).toBe(
      '5 Oct - 11 Oct 2026',
    );
    expect(rangeLabel('week', '2026-12-31', viewDays('week', '2026-12-31'))).toBe(
      '28 Dec 2026 - 3 Jan 2027',
    );
  });

  it('refuses a day that does not exist and an unknown view', () => {
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('09/10/2026')).toBeNull();
    expect(parseDay('2026-10-09')).toBe('2026-10-09');
    expect(parseView('year')).toBe('month');
    expect(parseView('agenda')).toBe('agenda');
  });
});

describe('the city filter', () => {
  const rows = [
    { venue: { city: 'Hyderabad', country: 'India' } },
    { venue: { city: 'hyderabad ', country: 'India' } },
    { venue: { city: 'Auckland', country: 'New Zealand' } },
    { venue: { city: '', country: null } },
  ];

  it('offers each city once, whatever its spelling, sorted', () => {
    expect(cityOptions(rows)).toEqual([
      { value: 'auckland', label: 'Auckland (New Zealand)' },
      { value: 'hyderabad', label: 'Hyderabad (India)' },
    ]);
  });

  it('keeps only that city, and everything when no city is chosen', () => {
    expect(inCity(rows, 'hyderabad')).toHaveLength(2);
    expect(inCity(rows, '')).toHaveLength(4);
  });
});

describe('the status vocabulary', () => {
  it('uses the console words, the same as the organizer calendar', () => {
    expect(statusText('UNDER_REVIEW')).toBe('In review');
    expect(statusText('ARCHIVED')).toBe('Ended');
    expect(statusTone('PUBLISHED')).toBe('success');
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
  });

  it('draws a stopped show by its own status, not its published event', () => {
    const published = { status: 'PUBLISHED' };
    expect(showStatus({ status: 'CANCELLED', event: published })).toEqual({
      status: 'CANCELLED',
      label: 'Show cancelled',
    });
    expect(showStatus({ status: 'PAUSED', event: published }).label).toBe('Show paused');
    expect(showStatus({ status: 'SCHEDULED', event: published })).toEqual({
      status: 'PUBLISHED',
      label: 'Published',
    });
  });
});

describe('entries for the shared calendar', () => {
  function show(id: string, startsAt: string, timezone: string | null, status = 'SCHEDULED') {
    return {
      id,
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 2 * 3_600_000).toISOString(),
      timezone,
      status,
      event: { title: `Film ${id}`, status: 'PUBLISHED' },
      organization: { name: 'Bengaluru Live' },
      venue: { city: 'Vijayawada' },
    };
  }

  it("draws each show at its venue's clock, on the venue's day, with the organizer", () => {
    // 13:30Z is 7:00 PM in Kolkata; 18:30Z on the 9th is 5:30 AM on the 10th in Sydney.
    const days = viewDays('week', '2026-10-09');
    const { byDay } = placeSessions(
      [
        show('k', '2026-10-09T13:30:00.000Z', 'Asia/Kolkata'),
        show('s', '2026-10-09T18:30:00.000Z', 'Australia/Sydney'),
      ],
      days,
    );
    const entries = entriesByDay(byDay);
    const k = entries.get('2026-10-09')![0];
    expect(k.start).toBe('7:00 PM');
    expect(k.time).toBe(`7:00 PM - 9:00 PM ${zoneNote(k.source.startsAt, 'Asia/Kolkata')}`);
    expect(k.detail).toBe('Bengaluru Live - Vijayawada');
    expect(k.label).toBe(
      `7:00 PM ${zoneNote(k.source.startsAt, 'Asia/Kolkata')}, Film k, Bengaluru Live - Vijayawada. Published`,
    );
    expect(entries.get('2026-10-10')!.map((e) => e.id)).toEqual(['s']);
    expect(entries.get('2026-10-10')![0].start).toBe('5:30 AM');
  });

  it('a cancelled show is drawn cancelled, in the admin word', () => {
    const { byDay } = placeSessions(
      [show('c', '2026-10-09T13:30:00.000Z', 'Asia/Kolkata', 'CANCELLED')],
      ['2026-10-09'],
    );
    const e = entriesByDay(byDay).get('2026-10-09')![0];
    expect(e.statusLabel).toBe('Show cancelled');
    expect(e.struck).toBe(true);
  });

  it('cuts the drawn days into weeks of seven', () => {
    const weeks = toWeeks(viewDays('month', '2026-10-09'));
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0]).toBe('2026-09-28');
  });
});
