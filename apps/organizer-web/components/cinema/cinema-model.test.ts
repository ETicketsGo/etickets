import { describe, expect, it } from 'vitest';
import type { Movie, PilotReadinessReport, ShowRow } from '@eticketsgo/web-kit';
import {
  cinemaSaleState,
  dayHeading,
  filmSaleSummary,
  filterFilms,
  formatRuntime,
  glanceByCinema,
  groupByDay,
  programmeOf,
  shortSaleReason,
  showSaleVerdict,
  zoneShort,
  type CinemaSaleState,
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

const report = (
  checks: {
    code: string;
    level: 'READY' | 'BLOCKED' | 'WARNING';
    message?: string;
    fixPath?: string | null;
  }[],
): PilotReadinessReport => ({
  cinemaId: 'c1',
  cinemaName: 'Cinema',
  timezone: 'Asia/Kolkata',
  overall: 'READY',
  blockers: 0,
  warnings: 0,
  evaluatedAt: NOW.toISOString(),
  sections: [
    {
      section: 'SALES',
      level: 'READY',
      checks: checks.map((c) => ({
        section: 'SALES',
        code: c.code,
        level: c.level,
        message: c.message ?? c.code,
        fixPath: c.fixPath ?? null,
      })),
    },
  ],
});

const TELANGANA = report([
  {
    code: 'SALE_NO_PRICING_POLICY',
    level: 'BLOCKED',
    message:
      'Ticket sales are paused for cinemas in Telangana: no state price rules are configured yet. Contact support.',
  },
]);

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

describe('cinemaSaleState', () => {
  it('reads the SALES section the server builds from saleEligibility', () => {
    expect(
      cinemaSaleState(report([{ code: 'SALES_OPEN', level: 'READY' }]), 'Andhra Pradesh'),
    ).toEqual({ kind: 'SELLING' });
    const tg = cinemaSaleState(TELANGANA, 'Telangana');
    expect(tg.kind).toBe('NOT_SELLING');
    expect(tg.kind === 'NOT_SELLING' && tg.reason).toBe('Telangana pricing rules not configured');
  });
  it('treats a seat-category problem as partial, not as the whole cinema', () => {
    const s = cinemaSaleState(
      report([{ code: 'SALE_SEAT_CLASS_UNMAPPED', level: 'BLOCKED' }]),
      'Andhra Pradesh',
    );
    expect(s.kind).toBe('PARTLY');
  });
  it('never claims selling without a report', () => {
    expect(cinemaSaleState(null, 'Telangana').kind).toBe('UNKNOWN');
  });
  it('short reasons fall back to a generic place', () => {
    expect(shortSaleReason('SALE_NO_PRICING_POLICY', null)).toBe(
      'state pricing rules not configured',
    );
    expect(shortSaleReason('SALE_SOMETHING_NEW', 'X')).toBe('pricing not cleared for online sale');
  });
});

describe('showSaleVerdict', () => {
  const base = {
    show: show(),
    now: NOW,
    timeZone: 'Asia/Kolkata',
    filmStatus: 'PUBLISHED',
    online: { open: true, closedTicketTypeIds: [] },
    cinema: { kind: 'SELLING' } as CinemaSaleState,
  };

  it('says Selling only when the server says the show is open', () => {
    expect(showSaleVerdict(base)).toMatchObject({ selling: true, label: 'Selling' });
  });

  it('a Telangana show is Not selling, with the reason, even though it is scheduled', () => {
    const v = showSaleVerdict({
      ...base,
      online: { open: false, closedTicketTypeIds: [] },
      cinema: cinemaSaleState(TELANGANA, 'Telangana'),
    });
    expect(v.selling).toBe(false);
    expect(v.label).toBe('Not selling: Telangana pricing rules not configured');
    expect(v.detail).toMatch(/no state price rules/);
  });

  it('is never Selling while the answer is loading or unreadable', () => {
    expect(showSaleVerdict({ ...base, online: undefined })).toMatchObject({
      selling: false,
      label: 'Checking sale status',
    });
    expect(showSaleVerdict({ ...base, online: null })).toMatchObject({
      selling: false,
      label: 'Sale status unavailable',
    });
  });

  it('a closed show without a known reason still says it is not selling', () => {
    expect(
      showSaleVerdict({
        ...base,
        online: { open: false, closedTicketTypeIds: [] },
        cinema: { kind: 'UNKNOWN' },
      }).label,
    ).toBe('Not selling: online booking not open');
  });

  it("the show's own state outranks the regulatory answer", () => {
    expect(showSaleVerdict({ ...base, show: show({ status: 'PAUSED' }) }).label).toBe(
      'Not selling: sales paused',
    );
    expect(showSaleVerdict({ ...base, show: show({ status: 'CANCELLED' }) }).label).toBe(
      'Not selling: show cancelled',
    );
    expect(
      showSaleVerdict({ ...base, show: show({ startsAt: '2026-10-10T05:00:00Z' }) }).label,
    ).toBe('Not selling: show has started');
    expect(
      showSaleVerdict({ ...base, show: show({ salesStartAt: '2026-10-10T08:00:00Z' }) }).label,
    ).toBe('Not selling: bookings open Sat 10 Oct, 13:30');
    expect(showSaleVerdict({ ...base, filmStatus: 'DRAFT' }).label).toBe(
      'Not selling: film not published',
    );
  });

  it('notes seat categories that cannot be sold on a show that otherwise sells', () => {
    const v = showSaleVerdict({ ...base, online: { open: true, closedTicketTypeIds: ['t1'] } });
    expect(v.selling).toBe(true);
    expect(v.detail).toMatch(/Some seat categories cannot be sold/);
  });
});

describe('filmSaleSummary', () => {
  const rows = [
    show({ sessionId: 'a' }),
    show({ sessionId: 'b', cinemaId: 'c2', cinemaName: 'Hyderabad Screens' }),
  ];
  const programme = programmeOf(rows, NOW);
  const tg = cinemaSaleState(TELANGANA, 'Telangana');

  it('one cinema selling and one not is ONE partial state, never plain "Selling"', () => {
    const s = filmSaleSummary(movie(), programme, rows, NOW, (id) =>
      id === 'c2' ? tg : { kind: 'SELLING' },
    );
    expect(s.label).toBe('Selling at 1 of 2 cinemas');
    expect(s.label).not.toBe('Selling');
    expect(s.selling).toBe(false);
    expect(s.partial).toBe(true);
    expect(s.tone).not.toBe('success');
    expect(s.exceptions).toEqual([
      { cinema: 'Hyderabad Screens', reason: 'Telangana pricing rules not configured' },
    ]);
  });

  it('is plain "Selling" only when every upcoming show can be bought', () => {
    const s = filmSaleSummary(movie(), programme, rows, NOW, () => ({ kind: 'SELLING' }));
    expect(s).toMatchObject({ label: 'Selling', selling: true, partial: false, tone: 'success' });
  });

  it('a paused show among selling ones is partial too', () => {
    const mixed = [rows[0]!, { ...rows[0]!, sessionId: 'p', status: 'PAUSED' }];
    const s = filmSaleSummary(movie(), programmeOf(mixed, NOW), mixed, NOW, () => ({
      kind: 'SELLING',
    }));
    expect(s.label).toBe('Selling 1 of 2 upcoming shows');
    expect(s.partial).toBe(true);
  });

  it('a seat-category problem at the only cinema is partial, not plain "Selling"', () => {
    const partly = cinemaSaleState(
      report([{ code: 'SALE_SEAT_CLASS_UNMAPPED', level: 'BLOCKED' }]),
      'Andhra Pradesh',
    );
    const one = [rows[0]!];
    const s = filmSaleSummary(movie(), programmeOf(one, NOW), one, NOW, () => partly);
    expect(s.label).toBe('Selling, with exceptions');
    expect(s.partial).toBe(true);
  });

  it('is Not selling when no cinema can sell', () => {
    const s = filmSaleSummary(movie(), programme, rows, NOW, () => tg);
    expect(s.selling).toBe(false);
    expect(s.label).toBe('Not selling: Telangana pricing rules not configured');
  });

  it('does not guess while a cinema is unanswered', () => {
    expect(filmSaleSummary(movie(), programme, rows, NOW, () => ({ kind: 'UNKNOWN' })).label).toBe(
      'Sale status not confirmed',
    );
  });

  it('a draft film is not selling, and a film with nothing ahead says so', () => {
    expect(
      filmSaleSummary(movie({ status: 'DRAFT' }), programme, rows, NOW, () => ({ kind: 'SELLING' }))
        .label,
    ).toBe('Not selling: film not published');
    expect(
      filmSaleSummary(movie(), programmeOf([], NOW), [], NOW, () => ({ kind: 'SELLING' })).label,
    ).toBe('No upcoming shows');
  });

  it('paused shows everywhere mean nothing is open', () => {
    const paused = rows.map((r) => ({ ...r, status: 'PAUSED' }));
    expect(
      filmSaleSummary(movie(), programmeOf(paused, NOW), paused, NOW, () => ({ kind: 'SELLING' }))
        .label,
    ).toBe('Not selling: no show open for booking');
  });
});

describe('zoneShort', () => {
  it('names an Indian cinema clock IST, not GMT+5:30', () => {
    expect(zoneShort('2026-10-10T13:30:00Z', 'Asia/Kolkata')).toBe('IST');
    expect(zoneShort('2026-10-10T13:30:00Z', 'America/Denver')).toBe('MDT');
    expect(zoneShort('2026-10-10T13:30:00Z', undefined)).toBe('');
  });
});
