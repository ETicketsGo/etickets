import { DiscoveryService } from './discovery.service';
import type { RecommendationEngine } from '../ai/ai.ports';

describe('DiscoveryService.get', () => {
  const movieCards = [
    {
      id: 'mv1',
      title: 'Dune',
      slug: 'dune',
      posterUrl: null,
      certificate: 'UA',
      language: 'en',
      genres: ['sci-fi'],
      runtimeMinutes: 155,
    },
  ];
  const trendingCards = [
    {
      id: 'ev1',
      title: 'Jazz Night',
      slug: 'jazz-night',
      category: 'Music',
      venue: { name: 'Hall', city: 'BLR', country: 'IN' },
      organizer: 'Org',
      nextSessionAt: null,
      fromPriceMinor: 50000,
      currency: 'INR',
    },
  ];
  const weekendCards = [
    {
      id: 'ev2',
      title: 'Comedy Fest',
      slug: 'comedy-fest',
      category: 'Comedy',
      venue: { name: 'Club', city: 'BLR', country: 'IN' },
      organizer: 'Org',
      nextSessionAt: null,
      fromPriceMinor: 30000,
      currency: 'INR',
    },
  ];

  function makeService() {
    const publicMovies = { list: jest.fn().mockResolvedValue(movieCards) };
    const publicEvents = {
      list: jest
        .fn()
        // 1st call = trending (no date filter), 2nd call = this weekend (date filter)
        .mockResolvedValueOnce({ data: trendingCards, meta: {} })
        .mockResolvedValueOnce({ data: weekendCards, meta: {} }),
    };
    const prisma = {
      event: {
        findMany: jest.fn().mockResolvedValue([{ category: 'Comedy' }, { category: 'Music' }]),
      },
    };
    // Identity behaviour, like the Noop binding. Typed loosely because the port
    // method is generic (`rankExperiences<T>`), which jest.Mocked cannot model.
    const rankExperiences = jest.fn((_userId: string | null, items: unknown[]) =>
      Promise.resolve(items),
    );
    const recommender = { rankExperiences } as unknown as RecommendationEngine;
    // Pass-through cache: always run the producer, so these tests exercise the
    // real composition (the CacheService has its own dedicated spec).
    const cache = {
      getOrSet: jest.fn((_key: string, _ttl: number, producer: () => Promise<unknown>) =>
        producer(),
      ),
    };
    const service = new DiscoveryService(
      prisma as never,
      publicMovies as never,
      publicEvents as never,
      recommender,
      cache as never,
    );
    return { service, publicMovies, publicEvents, prisma, rankExperiences, cache };
  }

  it('composes all four discovery sections from the reused public services', async () => {
    const { service, publicEvents, prisma } = makeService();

    const result = await service.get();

    expect(result.nowShowing).toEqual(movieCards);
    expect(result.trendingEvents).toEqual(trendingCards);
    expect(result.thisWeekend).toEqual(weekendCards);
    expect(result.categories).toEqual(['Comedy', 'Music']);

    // Trending list is page 1, small page size, and unfiltered by date.
    expect(publicEvents.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1, pageSize: 8 }),
    );
    // Weekend list reuses the dateFrom/dateTo filter.
    const weekendArgs = publicEvents.list.mock.calls[1][0];
    expect(weekendArgs.dateFrom).toBeInstanceOf(Date);
    expect(weekendArgs.dateTo).toBeInstanceOf(Date);
    expect(weekendArgs.dateTo.getTime()).toBeGreaterThanOrEqual(weekendArgs.dateFrom.getTime());

    // Categories come from a distinct query over published EVENT categories.
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ distinct: ['category'] }),
    );
  });

  it('routes now-showing and trending through the RecommendationEngine port', async () => {
    const { service, rankExperiences } = makeService();

    await service.get();

    expect(rankExperiences).toHaveBeenCalledTimes(2);
    expect(rankExperiences).toHaveBeenCalledWith(null, movieCards);
    expect(rankExperiences).toHaveBeenCalledWith(null, trendingCards);
  });

  /*
    The top of Explore - Now showing, Trending, This weekend and the category chips - comes
    from here, and this took no place at all and cached one answer for everybody. The owner
    opened Explore from the United States and saw Indian shows throughout, after every other
    list on the storefront had been scoped.
  */
  describe('scoped to where the visitor is browsing', () => {
    it('asks every list for the visitor country', async () => {
      const { service, publicMovies, publicEvents, prisma } = makeService();

      await service.get({ country: 'US' });

      expect(publicMovies.list).toHaveBeenCalledWith(expect.objectContaining({ country: 'US' }));
      for (const call of publicEvents.list.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ country: 'US' }));
      }
      // The category chips too: a chip for a category with nothing here is a dead end.
      const where = prisma.event.findMany.mock.calls[0][0].where;
      expect(where.venue.country.in).toEqual(expect.arrayContaining(['us']));
    });

    it('only offers categories with a show still to come', async () => {
      const { service, prisma } = makeService();

      await service.get({ country: 'IN' });

      const where = prisma.event.findMany.mock.calls[0][0].where;
      expect(where.sessions.some.startsAt.gte).toBeInstanceOf(Date);
    });

    it('lets a chosen city win over the country', async () => {
      const { service, prisma } = makeService();

      await service.get({ city: 'Hyderabad', country: 'US' });

      const where = prisma.event.findMany.mock.calls[0][0].where;
      expect(where.venue).toEqual({ city: { equals: 'Hyderabad', mode: 'insensitive' } });
    });

    it('caches each place separately, so one visitor never gets another place', async () => {
      const { service, cache, publicEvents } = makeService();
      // Three compositions make six list calls; the harness only scripts the first two.
      publicEvents.list.mockResolvedValue({ data: [], meta: {} });

      await service.get({ country: 'US' });
      await service.get({ country: 'IN' });
      await service.get();

      const keys = cache.getOrSet.mock.calls.map((c) => c[0]);
      expect(new Set(keys).size).toBe(3);
    });
  });
});
