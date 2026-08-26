import { PublicMoviesService } from './movies.service';

/**
 * What belongs in the public film catalogue.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────────────
 * The catalogue used to ask only whether the MOVIE was published, and — when a city was
 * named — whether it had any movie-experience event at a venue there. Neither clause looked
 * at the event's own status or at whether one showing was still to come, so films whose run
 * had finished and films whose events were still drafts stayed on the shelf. On QA that was
 * four of seven: a customer taps a poster, lands on a page with no showtimes, and concludes
 * the site is broken.
 *
 * These tests assert the QUERY rather than the result, because the filtering happens in the
 * database and a stubbed client returns whatever it is handed. What can be checked here is
 * the thing that was actually wrong: which conditions the query carries.
 */

const passthroughCache = () =>
  ({
    getOrSet: jest.fn((_k: string, _t: number, producer: () => Promise<unknown>) => producer()),
  }) as never;

const advertised = { forListing: (x: unknown) => x, apply: (x: unknown) => x } as never;

function makeService() {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { movie: { findMany } } as never;
  return { service: new PublicMoviesService(prisma, passthroughCache(), advertised), findMany };
}

/** The `events: { some: … }` clause the catalogue query was built with. */
async function eventsClause(filters: Record<string, unknown> = {}) {
  const { service, findMany } = makeService();
  await service.list(filters as never);
  return findMany.mock.calls[0][0].where.events.some;
}

describe('the public film catalogue', () => {
  it('only lists films with a showing still to come', async () => {
    const some = await eventsClause();
    // The condition whose absence put four unbookable films on QA's shelf.
    expect(some.sessions).toEqual({ some: { startsAt: { gte: expect.any(Date) } } });
  });

  it('ignores showings whose event has not been published', async () => {
    const some = await eventsClause();
    // A draft event is an organizer still working. It must not advertise a film.
    expect(some.status).toBe('PUBLISHED');
  });

  it('counts only movie experiences, never ordinary events', async () => {
    const some = await eventsClause();
    expect(some.experienceType).toBe('MOVIE');
  });

  it('applies the city to the bookable showing, not to any event at all', async () => {
    /*
      The subtle half of the same bug.

      Asking "does this film have a bookable showing anywhere, AND an event in Bengaluru"
      would list a film playing only in Mumbai whose finished Bengaluru run still exists.
      Both conditions have to describe the SAME showing, which means one `some`.
    */
    const some = await eventsClause({ city: 'Bengaluru' });
    expect(some.venue).toEqual({ city: { equals: 'Bengaluru', mode: 'insensitive' } });
    expect(some.status).toBe('PUBLISHED');
    expect(some.sessions).toBeDefined();
  });

  it('still requires the film itself to be published', async () => {
    const { service, findMany } = makeService();
    await service.list({} as never);
    expect(findMany.mock.calls[0][0].where.status).toBe('PUBLISHED');
  });

  it('keeps the free-text and genre filters working alongside it', async () => {
    const { service, findMany } = makeService();
    await service.list({ q: 'moon', genre: 'Family' } as never);
    const where = findMany.mock.calls[0][0].where;
    expect(where.title).toEqual({ contains: 'moon', mode: 'insensitive' });
    expect(where.genres).toEqual({ has: 'Family' });
    // …and that the bookability rule is not dropped when other filters are present.
    expect(where.events.some.sessions).toBeDefined();
  });
});
