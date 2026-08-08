import { PublicMoviesService } from './movies.service';
import { AppException } from '../common/errors';

/**
 * These tests are mostly about what the endpoint REFUSES to return. It is
 * unauthenticated, so anything that leaks here leaks to the internet.
 */

const PUBLISHED_MOVIE = {
  id: 'mv_1',
  organizationId: 'org_1',
  title: 'Skyfront Protocol',
  slug: 'skyfront-protocol',
  synopsis: 'A film.',
  runtimeMinutes: 124,
  certificate: 'UA',
  language: 'English',
  genres: ['Action', 'Thriller'],
  releaseDate: new Date('2026-07-01T00:00:00.000Z'),
  posterUrl: 'https://cdn.example/p.jpg',
  trailerUrl: null,
  cast: ['A Person'],
  director: 'Someone',
  status: 'PUBLISHED',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess_1',
    screenId: 'scr_1',
    startsAt: new Date('2026-09-01T14:00:00.000Z'),
    endsAt: new Date('2026-09-01T16:04:00.000Z'),
    event: {
      id: 'ev_1',
      slug: 'skyfront-protocol-show-598484',
      venue: { id: 'v_1', name: 'Phoenix Arena', city: 'Bengaluru', country: 'India' },
    },
    screen: {
      id: 'scr_1',
      name: 'Screen 1',
      screenType: 'IMAX',
      cinema: { id: 'cin_1', name: 'Phoenix Cinemas', brand: 'Phoenix' },
    },
    ticketTypes: [
      {
        id: 'tt_1',
        priceMinor: 20000,
        currency: 'INR',
        inventory: { quantityTotal: 100, quantitySold: 0, quantityHeld: 0 },
      },
    ],
    ...overrides,
  };
}

function makeService(opts: {
  movie?: unknown;
  sessions?: unknown[];
  total?: number;
  seatGroups?: { eventSessionId: string; status: string; _count: { _all: number } }[];
}) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(opts.movie === undefined ? PUBLISHED_MOVIE : opts.movie);
  const count = jest.fn();
  const findMany = jest.fn();
  const groupBy = jest.fn().mockResolvedValue(opts.seatGroups ?? []);
  const $transaction = jest
    .fn()
    .mockResolvedValue([opts.total ?? opts.sessions?.length ?? 0, opts.sessions ?? []]);

  const prisma = {
    movie: { findUnique },
    eventSession: { count, findMany },
    showSeat: { groupBy },
    $transaction,
  };
  // The service also takes a CacheService, used only by list(). shows() reads live
  // inventory and deliberately does not cache, so this stub is never called.
  const cache = { getOrSet: jest.fn() };

  return {
    service: new PublicMoviesService(prisma as never, cache as never),
    findUnique,
    count,
    groupBy,
    $transaction,
    cache,
  };
}

describe('GET /public/movies/:slug/shows — what is queried', () => {
  it('requires a published listing, a scheduled session, and a future start', async () => {
    const { service, $transaction, count } = makeService({ sessions: [] });

    await service.shows('skyfront-protocol', { limit: 50 });

    const where = count.mock.calls[0][0].where;
    /**
     * UPDATED EXPECTATION. This asserted `'SCHEDULED'` exactly, which excluded paused shows
     * from the listing entirely — a show whose sales an operator had stopped simply
     * vanished, which reads as a bug to a customer who was about to book it. PAUSED is now
     * listed and marked unbookable via `availability: 'SALES_PAUSED'`.
     *
     * CANCELLED and COMPLETED remain excluded, and the assertion below is deliberately
     * exact so adding either one silently fails here.
     */
    expect(where.status).toEqual({ in: ['SCHEDULED', 'PAUSED'] });
    expect(where.event.status).toBe('PUBLISHED');
    expect(where.event.experienceType).toBe('MOVIE');
    // Scoped to THIS film — the mechanism that keeps another tenant's screenings out.
    expect(where.event.movieId).toBe('mv_1');
    expect(where.startsAt.gte).toBeInstanceOf(Date);
    expect($transaction).toHaveBeenCalled();
  });

  it('marks a paused show SALES_PAUSED instead of hiding it', async () => {
    const { service } = makeService({
      sessions: [session({ id: 'ses_paused', status: 'PAUSED' })],
    });

    const result = await service.shows('skyfront-protocol', { limit: 50 });

    expect(result.shows).toHaveLength(1);
    expect(result.shows[0].availability).toBe('SALES_PAUSED');
  });

  it('does not advertise remaining seats on a paused show', async () => {
    // A closed show reporting "AVAILABLE" would put a Book button on something that will
    // refuse the booking.
    const { service } = makeService({
      sessions: [session({ id: 'ses_paused', status: 'PAUSED' })],
      seatGroups: [{ eventSessionId: 'ses_paused', status: 'AVAILABLE', _count: { _all: 200 } }],
    });

    const result = await service.shows('skyfront-protocol', { limit: 50 });

    expect(result.shows[0].availability).toBe('SALES_PAUSED');
  });

  it('clamps a past `from` to now, so history is never bookable', async () => {
    const { service, count } = makeService({ sessions: [] });

    await service.shows('skyfront-protocol', {
      from: new Date('2000-01-01T00:00:00.000Z'),
      limit: 50,
    });

    const gte = count.mock.calls[0][0].where.startsAt.gte as Date;
    expect(gte.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
  });

  it('honours a future `from` and an exclusive `to`', async () => {
    const { service, count } = makeService({ sessions: [] });
    const from = new Date(Date.now() + 86_400_000);
    const to = new Date(Date.now() + 172_800_000);

    await service.shows('skyfront-protocol', { from, to, limit: 50 });

    const where = count.mock.calls[0][0].where;
    expect(where.startsAt.gte).toEqual(from);
    expect(where.startsAt.lt).toEqual(to);
  });

  it('filters by city case-insensitively', async () => {
    const { service, count } = makeService({ sessions: [] });

    await service.shows('skyfront-protocol', { city: 'bengaluru', limit: 50 });

    expect(count.mock.calls[0][0].where.event.venue).toEqual({
      city: { equals: 'bengaluru', mode: 'insensitive' },
    });
  });

  it('caps limit at 200 however large the request', async () => {
    const { service } = makeService({ sessions: [] });

    const result = await service.shows('skyfront-protocol', { limit: 100_000 });

    expect(result.meta.limit).toBe(200);
  });

  it('404s before querying shows when the film is not published', async () => {
    const { service, count } = makeService({ movie: { ...PUBLISHED_MOVIE, status: 'DRAFT' } });

    await expect(service.shows('skyfront-protocol', { limit: 10 })).rejects.toBeInstanceOf(
      AppException,
    );
    expect(count).not.toHaveBeenCalled();
  });
});

describe('GET /public/movies/:slug/shows — the response', () => {
  it('returns an empty list, not a 404, for a film with nothing on', async () => {
    const { service } = makeService({ sessions: [], total: 0 });

    const result = await service.shows('skyfront-protocol', { limit: 50 });

    // The film exists and deserves a page; it simply has no screenings.
    expect(result.shows).toEqual([]);
    expect(result.movie.title).toBe('Skyfront Protocol');
    expect(result.filters).toEqual({ dates: [], cities: [], formats: [], languages: [] });
  });

  it('carries the keys a client groups by, and the slugs it continues with', async () => {
    const { service } = makeService({
      sessions: [session()],
      seatGroups: [{ eventSessionId: 'sess_1', status: 'AVAILABLE', _count: { _all: 80 } }],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    expect(show.startsAt).toBe('2026-09-01T14:00:00.000Z');
    expect(show.venue.city).toBe('Bengaluru');
    expect(show.cinema).toEqual({ id: 'cin_1', name: 'Phoenix Cinemas', brand: 'Phoenix' });
    expect(show.format).toBe('IMAX');
    expect(show.language).toBe('English');
    // The two identifiers the rest of the journey needs.
    expect(show.eventSlug).toBe('skyfront-protocol-show-598484');
    expect(show.sessionId).toBe('sess_1');
  });

  it('reports a reserved-seating show with real seat counts', async () => {
    const { service } = makeService({
      sessions: [session()],
      seatGroups: [
        { eventSessionId: 'sess_1', status: 'AVAILABLE', _count: { _all: 60 } },
        { eventSessionId: 'sess_1', status: 'SOLD', _count: { _all: 20 } },
      ],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    expect(show.seatingType).toBe('RESERVED');
    expect(show.seatsAvailable).toBe(60);
    expect(show.seatsTotal).toBe(80);
    expect(show.availability).toBe('AVAILABLE');
  });

  it('reports a general-admission show from ticket inventory, with null seat counts', async () => {
    const { service } = makeService({
      sessions: [session({ screenId: null, screen: null })],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    expect(show.seatingType).toBe('GENERAL_ADMISSION');
    expect(show.seatsAvailable).toBeNull();
    expect(show.seatsTotal).toBeNull();
    expect(show.format).toBeNull();
    expect(show.availability).toBe('AVAILABLE');
  });

  it('marks a show with no available seats SOLD_OUT', async () => {
    const { service } = makeService({
      sessions: [session()],
      seatGroups: [{ eventSessionId: 'sess_1', status: 'SOLD', _count: { _all: 80 } }],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    expect(show.availability).toBe('SOLD_OUT');
    expect(show.seatsAvailable).toBe(0);
  });

  it('marks a nearly-full show LIMITED', async () => {
    const { service } = makeService({
      sessions: [session()],
      seatGroups: [
        { eventSessionId: 'sess_1', status: 'AVAILABLE', _count: { _all: 5 } },
        { eventSessionId: 'sess_1', status: 'SOLD', _count: { _all: 75 } },
      ],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    expect(show.availability).toBe('LIMITED');
  });

  it('treats a show with nothing on sale as SOLD_OUT rather than free', async () => {
    // Failing the other way would advertise a bookable show with no price.
    const { service } = makeService({
      sessions: [session({ ticketTypes: [] })],
      seatGroups: [{ eventSessionId: 'sess_1', status: 'AVAILABLE', _count: { _all: 80 } }],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    expect(show.availability).toBe('SOLD_OUT');
    expect(show.fromPriceMinor).toBeNull();
  });

  it('collects distinct dates, cities and formats across venues', async () => {
    const { service } = makeService({
      sessions: [
        session(),
        session({
          id: 'sess_2',
          screenId: 'scr_2',
          startsAt: new Date('2026-09-02T10:00:00.000Z'),
          endsAt: new Date('2026-09-02T12:04:00.000Z'),
          event: {
            id: 'ev_2',
            slug: 'skyfront-protocol-show-772211',
            venue: { id: 'v_2', name: 'NSCI Dome', city: 'Mumbai', country: 'India' },
          },
          screen: {
            id: 'scr_2',
            name: 'Audi 3',
            screenType: '2D',
            cinema: { id: 'cin_2', name: 'Dome Cinemas', brand: null },
          },
        }),
      ],
      seatGroups: [
        { eventSessionId: 'sess_1', status: 'AVAILABLE', _count: { _all: 80 } },
        { eventSessionId: 'sess_2', status: 'AVAILABLE', _count: { _all: 40 } },
      ],
    });

    const result = await service.shows('skyfront-protocol', { limit: 50 });

    expect(result.shows).toHaveLength(2);
    expect(result.filters.dates).toEqual(['2026-09-01', '2026-09-02']);
    expect(result.filters.cities).toEqual(['Bengaluru', 'Mumbai']);
    expect(result.filters.formats).toEqual(['2D', 'IMAX']);
  });

  it('aggregates seat counts in ONE grouped query, not one per show', async () => {
    // An unauthenticated endpoint must not do N queries for N screenings.
    const { service, groupBy } = makeService({
      sessions: [session(), session({ id: 'sess_2' }), session({ id: 'sess_3' })],
      seatGroups: [],
    });

    await service.shows('skyfront-protocol', { limit: 50 });

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0][0].where.eventSessionId.in).toEqual([
      'sess_1',
      'sess_2',
      'sess_3',
    ]);
  });

  it('skips the seat query entirely when every show is general admission', async () => {
    const { service, groupBy } = makeService({
      sessions: [session({ screenId: null, screen: null })],
    });

    await service.shows('skyfront-protocol', { limit: 50 });

    expect(groupBy).not.toHaveBeenCalled();
  });

  it('never exposes organizer or inventory internals on a show', async () => {
    const { service } = makeService({
      sessions: [session()],
      seatGroups: [{ eventSessionId: 'sess_1', status: 'AVAILABLE', _count: { _all: 80 } }],
    });

    const [show] = (await service.shows('skyfront-protocol', { limit: 50 })).shows;

    for (const leaked of ['organizationId', 'feeMode', 'ticketTypes', 'inventory', 'status']) {
      expect(show).not.toHaveProperty(leaked);
    }
  });
});
