import { describe, expect, it } from 'vitest';
import type { Movie, ShowRow } from '@eticketsgo/web-kit';
import {
  cinemaSaleVerdict,
  dayHeading,
  filmSaleSummary,
  filterFilms,
  formatRuntime,
  glanceByCinema,
  groupByDay,
  programmeOf,
  showSaleVerdict,
  zoneShort,
  type MaybeSale,
} from './cinema-model';

const NOW = new Date('2026-10-10T06:00:00Z'); // 11:30 in Kolkata

const show = (over: Partial<ShowRow> = {}): ShowRow => ({
  sessionId: 's1',
  startsAt: '2026-10-10T13:30:00Z',
  endsAt: '2026-10-10T16:00:00Z',
  screenId: 'scr1',
  screenName: 'Screen 1',
  cinemaId: 'c1',
  cinemaName: 'Vijayawada Multiplex',
  movieId: 'm1',
  movieTitle: 'Film',
  status: 'SCHEDULED',
  salesStartAt: null,
  salesEndAt: null,
  seatsSold: 10,
  seatsTotal: 100,
  ...over,
});

const movie = (over: Partial<Movie> = {}): Movie => ({
  id: 'm1',
  slug: 'film',
  status: 'PUBLISHED',
  createdAt: '2026-01-01T00:00:00Z',
  title: 'Film',
  runtimeMinutes: 138,
  language: 'Telugu',
  genres: ['Drama'],
  cast: ['Actor One'],
  director: 'A Director',
  ...over,
});

const TG_MESSAGE =
  'Ticket sales are paused for cinemas in Telangana: no state price rules are configured yet. Contact support.';

const why = (code: string, text: string, message = text, affectedSessions = 1) => ({
  code: code as never,
  text,
  message,
  owner: 'PLATFORM' as const,
  fixPath: null,
  ticketTypeIds: [],
  affectedSessions,
});
const SELLING = { state: 'SELLING' as const, reasons: [] };
const TELANGANA = {
  state: 'NOT_SELLING' as const,
  reasons: [why('NO_PRICING_POLICY', 'Telangana pricing rules not configured', TG_MESSAGE)],
};
const UNMAPPED = {
  state: 'PARTIAL' as const,
  reasons: [why('SEAT_CLASS_UNMAPPED', 'seat classes not mapped')],
};

describe('formatRuntime', () => {
  it('reads like a cinema listing', () => {
    expect(formatRuntime(138)).toBe('2h 18m');
    expect(formatRuntime(120)).toBe('2h');
    expect(formatRuntime(45)).toBe('45m');
    expect(formatRuntime(0)).toBeNull();
  });
});

describe('filterFilms', () => {
  const films = [
    movie(),
    movie({ id: 'm2', title: 'Other', status: 'DRAFT', language: 'Hindi', cast: [] }),
  ];
  it('searches title, cast and director, and filters by status and language', () => {
    expect(
      filterFilms(films, { q: 'actor one', status: '', language: '' }).map((m) => m.id),
    ).toEqual(['m1']);
    expect(filterFilms(films, { q: '', status: 'DRAFT', language: '' }).map((m) => m.id)).toEqual([
      'm2',
    ]);
    expect(filterFilms(films, { q: '', status: '', language: 'Telugu' }).map((m) => m.id)).toEqual([
      'm1',
    ]);
  });
});

describe('programmeOf', () => {
  it('counts only shows still to play, and names where they play', () => {
    const p = programmeOf(
      [
        show({ sessionId: 'past', startsAt: '2026-10-09T13:30:00Z' }),
        show({ sessionId: 'cx', status: 'CANCELLED' }),
        show({ sessionId: 'a' }),
        show({
          sessionId: 'b',
          cinemaId: 'c2',
          cinemaName: 'Hyderabad Screens',
          startsAt: '2026-10-11T13:30:00Z',
        }),
        show({ sessionId: 'c', startsAt: '2026-10-12T13:30:00Z' }),
      ],
      NOW,
    );
    expect(p.upcoming).toBe(3);
    expect(p.cinemas.map((c) => `${c.name}:${c.shows}`)).toEqual([
      'Vijayawada Multiplex:2',
      'Hyderabad Screens:1',
    ]);
    expect(p.next?.sessionId).toBe('a');
  });
});

describe('groupByDay', () => {
  it("dates each show on its own cinema's calendar", () => {
    // 05:30 UTC on the 11th is 11:00 in Kolkata but 23:30 on the 10th in Boise.
    const rows = [
      show({ sessionId: 'in', startsAt: '2026-10-11T05:30:00Z', cinemaId: 'in' }),
      show({ sessionId: 'us', startsAt: '2026-10-11T05:30:00Z', cinemaId: 'us' }),
    ];
    const zone = (id: string | null) => (id === 'us' ? 'America/Boise' : 'Asia/Kolkata');
    expect(
      groupByDay(rows, zone).map((d) => `${d.date}:${d.shows.map((s) => s.sessionId).join(',')}`),
    ).toEqual(['2026-10-10:us', '2026-10-11:in']);
  });
  it('names today and tomorrow', () => {
    expect(dayHeading('2026-10-10', '2026-10-10')).toBe('Today');
    expect(dayHeading('2026-10-11', '2026-10-10')).toBe('Tomorrow');
    expect(dayHeading('2026-10-13', '2026-10-10')).toBe('Tue 13 Oct');
  });
});

describe('glanceByCinema', () => {
  it('sums today and the next seven days at the cinema, leaving cancelled shows out', () => {
    const g = glanceByCinema(
      [
        show({ sessionId: 'a', seatsSold: 20, seatsTotal: 100 }),
        show({ sessionId: 'b', startsAt: '2026-10-14T13:30:00Z', seatsSold: 5, seatsTotal: 100 }),
        show({ sessionId: 'x', status: 'CANCELLED', seatsSold: 50 }),
        show({ sessionId: 'far', startsAt: '2026-10-30T13:30:00Z' }),
      ],
      () => 'Asia/Kolkata',
      NOW,
    );
    expect(g).toHaveLength(1);
    expect(g[0]!.today).toEqual({ shows: 1, sold: 20, total: 100 });
    expect(g[0]!.week).toEqual({ shows: 2, sold: 25, total: 200 });
    expect(g[0]!.nextToday?.sessionId).toBe('a');
  });
});

describe('showSaleVerdict: the server answer for one show, in words', () => {
  const reason = (code: string, text: string, message: string, fixPath: string | null = null) => ({
    code: code as never,
    text,
    message,
    owner: (fixPath ? 'ORGANIZER' : 'PLATFORM') as 'ORGANIZER' | 'PLATFORM',
    fixPath,
    ticketTypeIds: ['t1'],
    affectedSessions: 1,
  });
  const base = { show: show(), timeZone: 'Asia/Kolkata' };

  it('says Selling only when the server says SELLING', () => {
    expect(showSaleVerdict({ ...base, sale: { state: 'SELLING', reasons: [] } })).toMatchObject({
      selling: true,
      label: 'Selling',
      tone: 'success',
    });
  });

  it('a show that sells Gold and refuses Standard is Partly selling, never Selling', () => {
    // The QA drawer: "Selling" with "Some seat categories cannot be sold" under it.
    const v = showSaleVerdict({
      ...base,
      sale: {
        state: 'PARTIAL',
        reasons: [
          reason(
            'SEAT_CLASS_UNMAPPED',
            'seat classes not mapped',
            'Seat category Standard needs a regulatory seat class.',
            '/organizer/cinemas/c1/readiness#seat-classes',
          ),
        ],
      },
    });
    expect(v.selling).toBe(false);
    expect(v.label).toBe('Partly selling: seat classes not mapped');
    expect(v.tone).toBe('info');
    expect(v.detail).toBe('Seat category Standard needs a regulatory seat class.');
    expect(v.fixPath).toBe('/organizer/cinemas/c1/readiness#seat-classes');
  });

  it('a Telangana show is Not selling, with the reason and no fix link (it is the platform)', () => {
    const v = showSaleVerdict({
      ...base,
      sale: {
        state: 'NOT_SELLING',
        reasons: [
          reason(
            'NO_PRICING_POLICY',
            'Telangana pricing rules not configured',
            'Ticket sales are paused for cinemas in Telangana: no state price rules are configured yet.',
          ),
        ],
      },
    });
    expect(v.label).toBe('Not selling: Telangana pricing rules not configured');
    expect(v.detail).toMatch(/no state price rules/);
    expect(v.fixPath).toBeNull();
  });

  it('is never Selling while the answer is loading or unreadable', () => {
    expect(showSaleVerdict({ ...base, sale: undefined })).toMatchObject({
      selling: false,
      label: 'Checking sale status',
    });
    expect(showSaleVerdict({ ...base, sale: null })).toMatchObject({
      selling: false,
      label: 'Sale status unavailable',
    });
  });

  it('dates a booking window that has not opened, on the cinema clock', () => {
    const v = showSaleVerdict({
      ...base,
      show: show({ salesStartAt: '2026-10-10T08:00:00Z' }),
      sale: {
        state: 'NOT_SELLING',
        reasons: [reason('SALES_NOT_STARTED', 'bookings not open yet', 'Not open yet.')],
      },
    });
    expect(v.label).toBe('Not selling: bookings open Sat 10 Oct, 13:30');
  });
});

describe('filmSaleSummary: the cinema listings folded, never a hopeful Selling', () => {
  // One listing (event) per film per venue: AP and Telangana here.
  const rows = [
    show({ sessionId: 'a', eventId: 'e-ap' }),
    show({ sessionId: 'b', eventId: 'e-tg', cinemaId: 'c2', cinemaName: 'Hyderabad Screens' }),
  ];
  const programme = programmeOf(rows, NOW);
  const answers =
    (map: Record<string, unknown>) =>
    (id: string): MaybeSale =>
      map[id] as MaybeSale;

  it('one cinema selling and one not is ONE partial state, never plain "Selling"', () => {
    const s = filmSaleSummary(
      movie(),
      programme,
      rows,
      NOW,
      answers({ 'e-ap': SELLING, 'e-tg': TELANGANA }),
    );
    expect(s.label).toBe('Partly selling: at 1 of 2 cinemas');
    expect(s.label).not.toBe('Selling');
    expect(s.selling).toBe(false);
    expect(s.partial).toBe(true);
    expect(s.tone).not.toBe('success');
    expect(s.exceptions).toEqual([
      { cinema: 'Hyderabad Screens', reason: 'Telangana pricing rules not configured' },
    ]);
  });

  it('is plain "Selling" only when every listing is', () => {
    const s = filmSaleSummary(movie(), programme, rows, NOW, () => SELLING);
    expect(s).toMatchObject({ label: 'Selling', selling: true, partial: false, tone: 'success' });
  });

  it('a seat-category problem at the only cinema is partial, with the reason', () => {
    const one = [rows[0]!];
    const s = filmSaleSummary(movie(), programmeOf(one, NOW), one, NOW, () => UNMAPPED);
    expect(s.label).toBe('Partly selling: seat classes not mapped');
    expect(s.partial).toBe(true);
  });

  it('is Not selling when no cinema can sell', () => {
    const s = filmSaleSummary(movie(), programme, rows, NOW, () => TELANGANA);
    expect(s.selling).toBe(false);
    expect(s.label).toBe('Not selling: Telangana pricing rules not configured');
  });

  it('does not guess while a listing is loading, unreadable or unnamed', () => {
    expect(filmSaleSummary(movie(), programme, rows, NOW, () => undefined).label).toBe(
      'Checking sale status',
    );
    expect(filmSaleSummary(movie(), programme, rows, NOW, () => null).label).toBe(
      'Sale status not confirmed',
    );
    // An older API sent no listing id.
    const bare = rows.map((r) => ({ ...r, eventId: undefined }));
    expect(filmSaleSummary(movie(), programme, bare, NOW, () => SELLING).label).toBe(
      'Sale status not confirmed',
    );
  });

  it('a draft film is not selling, and a film with nothing ahead says so', () => {
    expect(
      filmSaleSummary(movie({ status: 'DRAFT' }), programme, rows, NOW, () => SELLING).label,
    ).toBe('Not selling: film not published');
    expect(filmSaleSummary(movie(), programmeOf([], NOW), [], NOW, () => SELLING).label).toBe(
      'Not selling: no upcoming shows',
    );
  });
});

describe('cinemaSaleVerdict: the cinema strip uses the same three sentences', () => {
  const rows = [show({ sessionId: 'a', eventId: 'e1' }), show({ sessionId: 'b', eventId: 'e2' })];
  it('folds the listings at one cinema', () => {
    expect(cinemaSaleVerdict('c1', rows, NOW, () => SELLING).label).toBe('Selling');
    expect(
      cinemaSaleVerdict('c1', rows, NOW, (id) => (id === 'e1' ? SELLING : UNMAPPED)).label,
    ).toBe('Partly selling: seat classes not mapped');
    expect(cinemaSaleVerdict('c1', rows, NOW, () => TELANGANA).label).toBe(
      'Not selling: Telangana pricing rules not configured',
    );
    expect(cinemaSaleVerdict('elsewhere', rows, NOW, () => SELLING).label).toBe(
      'Not selling: no upcoming shows',
    );
  });
});

describe('zoneShort', () => {
  it('names an Indian cinema clock IST, not GMT+5:30', () => {
    expect(zoneShort('2026-10-10T13:30:00Z', 'Asia/Kolkata')).toBe('IST');
    expect(zoneShort('2026-10-10T13:30:00Z', 'America/Denver')).toBe('MDT');
    expect(zoneShort('2026-10-10T13:30:00Z', undefined)).toBe('');
  });
});
