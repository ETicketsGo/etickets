import {
  availableDates,
  groupShowsByCinema,
  isShowBookable,
  localDateKey,
  publicShowsResponseSchema,
  type PublicShow,
} from '../movie-schema';

/** Shaped from a real GET /public/movies/skyfront-protocol/shows response. */
function show(overrides: Partial<PublicShow> = {}): PublicShow {
  return {
    sessionId: 'sess_1',
    eventId: 'ev_1',
    eventSlug: 'skyfront-protocol-show-5a2e3b',
    startsAt: '2026-09-01T14:00:00.000Z',
    endsAt: '2026-09-01T16:18:00.000Z',
    venue: { id: 'v_1', name: 'Phoenix Arena', city: 'Bengaluru', country: 'India' },
    cinema: { id: 'cin_1', name: 'PVR Phoenix Whitefield', brand: 'PVR' },
    screen: { id: 'scr_1', name: 'Screen 1' },
    format: 'IMAX',
    language: 'English',
    currency: 'INR',
    fromPriceMinor: 20000,
    seatingType: 'RESERVED',
    availability: 'AVAILABLE',
    seatsAvailable: 80,
    seatsTotal: 80,
    ...overrides,
  };
}

describe('shows contract', () => {
  it('parses a real response, including a film with no screenings', () => {
    const empty = publicShowsResponseSchema.parse({
      movie: {
        id: 'mv_1',
        title: 'The Weight of Water',
        slug: 'the-weight-of-water',
        synopsis: null,
        runtimeMinutes: 124,
        certificate: 'U',
        language: 'Hindi',
        genres: ['Drama'],
        releaseDate: null,
        posterUrl: null,
        trailerUrl: null,
        cast: [],
        director: null,
      },
      shows: [],
      filters: { dates: [], cities: [], formats: [], languages: [] },
      meta: { total: 0, returned: 0, limit: 100 },
    });

    // An empty list is valid data — the film has a page, it just has nothing on.
    expect(empty.shows).toEqual([]);
  });

  it('accepts a general-admission show with null screen, format and seat counts', () => {
    const parsed = publicShowsResponseSchema.parse({
      movie: {
        id: 'mv_1',
        title: 'X',
        slug: 'x',
        synopsis: null,
        runtimeMinutes: 90,
        certificate: null,
        language: 'English',
        genres: [],
        releaseDate: null,
        posterUrl: null,
        trailerUrl: null,
        cast: [],
        director: null,
      },
      shows: [
        show({
          cinema: null,
          screen: null,
          format: null,
          seatingType: 'GENERAL_ADMISSION',
          seatsAvailable: null,
          seatsTotal: null,
        }),
      ],
      filters: {
        dates: ['2026-09-01'],
        cities: ['Bengaluru'],
        formats: [],
        languages: ['English'],
      },
      meta: { total: 1, returned: 1, limit: 100 },
    });

    expect(parsed.shows[0].seatingType).toBe('GENERAL_ADMISSION');
  });
});

describe('bookability', () => {
  it('allows AVAILABLE and LIMITED', () => {
    expect(isShowBookable(show({ availability: 'AVAILABLE' }))).toBe(true);
    expect(isShowBookable(show({ availability: 'LIMITED' }))).toBe(true);
  });

  it('blocks SOLD_OUT', () => {
    expect(isShowBookable(show({ availability: 'SOLD_OUT' }))).toBe(false);
  });

  it('blocks an unrecognised availability rather than assuming it is fine', () => {
    // Fail closed: a new server state must not become a bookable showtime by default.
    expect(isShowBookable(show({ availability: 'EMBARGOED' }))).toBe(false);
  });
});

describe('date grouping', () => {
  it('groups by the VIEWER’s local date, not UTC', () => {
    // 2026-09-01T20:30Z is 2026-09-02 in IST. The API cannot know the venue's zone, so
    // the client groups in the viewer's — asserted here against whatever zone the test
    // runs in, by comparing to the same computation rather than a hardcoded string.
    const iso = '2026-09-01T20:30:00.000Z';
    const local = new Date(iso);
    const expected = `${local.getFullYear()}-${`${local.getMonth() + 1}`.padStart(2, '0')}-${`${local.getDate()}`.padStart(2, '0')}`;

    expect(localDateKey(iso)).toBe(expected);
  });

  it('lists distinct dates ascending', () => {
    const dates = availableDates([
      show({ startsAt: '2026-09-03T10:00:00.000Z' }),
      show({ startsAt: '2026-09-01T10:00:00.000Z' }),
      show({ startsAt: '2026-09-01T18:00:00.000Z' }),
    ]);

    expect(dates).toHaveLength(2);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('cinema grouping', () => {
  it('groups screenings under their cinema', () => {
    const groups = groupShowsByCinema([
      show({ sessionId: 's1', startsAt: '2026-09-01T10:00:00.000Z' }),
      show({ sessionId: 's2', startsAt: '2026-09-01T14:00:00.000Z' }),
      show({
        sessionId: 's3',
        startsAt: '2026-09-01T12:00:00.000Z',
        cinema: { id: 'cin_2', name: 'Dome Cinemas', brand: null },
        venue: { id: 'v_2', name: 'NSCI Dome', city: 'Mumbai', country: 'India' },
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].cinemaName).toBe('PVR Phoenix Whitefield');
    expect(groups[0].shows.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(groups[1].cinemaName).toBe('Dome Cinemas');
  });

  it('orders cinemas by their earliest remaining screening, not alphabetically', () => {
    // Someone scanning for "what can I still get to" is served by soonest-first.
    const groups = groupShowsByCinema([
      show({ sessionId: 'late', startsAt: '2026-09-01T20:00:00.000Z' }),
      show({
        sessionId: 'early',
        startsAt: '2026-09-01T09:00:00.000Z',
        cinema: { id: 'cin_z', name: 'Zenith Screens', brand: null },
      }),
    ]);

    expect(groups[0].cinemaName).toBe('Zenith Screens');
  });

  it('orders showtimes within a cinema chronologically', () => {
    const groups = groupShowsByCinema([
      show({ sessionId: 'pm', startsAt: '2026-09-01T18:00:00.000Z' }),
      show({ sessionId: 'am', startsAt: '2026-09-01T09:00:00.000Z' }),
    ]);

    expect(groups[0].shows.map((s) => s.sessionId)).toEqual(['am', 'pm']);
  });

  it('falls back to the venue when a screening has no cinema attached', () => {
    const groups = groupShowsByCinema([show({ cinema: null })]);

    expect(groups[0].key).toBe('v_1');
    expect(groups[0].cinemaName).toBe('Phoenix Arena');
  });

  it('keeps multiple screens at one cinema in the same group', () => {
    const groups = groupShowsByCinema([
      show({ sessionId: 's1', screen: { id: 'scr_1', name: 'Screen 1' }, format: 'IMAX' }),
      show({
        sessionId: 's2',
        screen: { id: 'scr_2', name: 'Screen 4' },
        format: '2D',
        startsAt: '2026-09-01T16:00:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].shows.map((s) => s.format)).toEqual(['IMAX', '2D']);
  });
});
