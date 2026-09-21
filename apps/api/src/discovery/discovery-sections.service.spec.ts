import { DiscoverySectionsService } from './discovery-sections.service';
import type {
  DiscoverySection,
  DiscoveryStrategy,
} from './strategies/discovery-strategy.interface';

const strategyReturning = (section: DiscoverySection): DiscoveryStrategy => ({
  key: section.key,
  discover: jest.fn().mockResolvedValue(section),
});

// Pass-through cache: always runs the producer so these tests exercise the real
// composition. The CacheService itself has a dedicated spec.
const passthroughCache = () =>
  ({
    getOrSet: jest.fn((_key: string, _ttl: number, producer: () => Promise<unknown>) => producer()),
  }) as never;

/**
 * The cities the platform can sell in.
 *
 * The composer asks this rather than judging by whether the feed came back empty, because
 * some strategies (the organizer and venue spotlights) are platform-wide and keep the feed
 * non-empty for a city that has nothing at all.
 */
const locationWith = (...cities: string[]) =>
  ({
    cities: jest
      .fn()
      .mockResolvedValue(cities.map((city) => ({ city, country: 'India', eventCount: 1 }))),
  }) as never;

describe('DiscoverySectionsService', () => {
  it('composes registered strategies in order and drops empty sections', async () => {
    const full: DiscoverySection = {
      key: 'trending',
      title: 'T',
      kind: 'events',
      items: [{ id: 'e1' }],
    };
    const empty: DiscoverySection = { key: 'nearby', title: 'N', kind: 'events', items: [] };
    const movies: DiscoverySection = {
      key: 'new',
      title: 'M',
      kind: 'movies',
      items: [{ id: 'm1' }],
    };

    const service = new DiscoverySectionsService(
      [strategyReturning(full), strategyReturning(empty), strategyReturning(movies)],
      passthroughCache(),
      locationWith(),
    );

    const { sections } = await service.sections();

    expect(sections.map((s) => s.key)).toEqual(['trending', 'new']);
  });

  it('passes the city through to every strategy', async () => {
    const section: DiscoverySection = {
      key: 'nearby',
      title: 'N',
      kind: 'events',
      items: [{ id: 'e' }],
    };
    const strategy = strategyReturning(section);
    const service = new DiscoverySectionsService(
      [strategy],
      passthroughCache(),
      locationWith('BLR'),
    );

    await service.sections('BLR');

    expect(strategy.discover).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'BLR', now: expect.any(Date) }),
    );
  });

  it('returns an empty feed when every section is empty', async () => {
    const empty: DiscoverySection = { key: 'x', title: 'X', kind: 'events', items: [] };
    const service = new DiscoverySectionsService(
      [strategyReturning(empty)],
      passthroughCache(),
      locationWith(),
    );

    const { sections } = await service.sections();

    expect(sections).toEqual([]);
  });

  it('passes the country through when no city is chosen', async () => {
    /*
      The defect on Explore, at its root: the composer only ever passed a city, so a visitor
      scoped to a country with no city chosen - every visitor until they pick one - got
      sections filtered by nothing. From the United States the owner saw Hyderabad, Mumbai,
      Boise and Meridian on one page.
    */
    const strategy = strategyReturning({
      key: 'trending',
      title: 'T',
      kind: 'events',
      items: [{ id: 'e' }],
    });
    const service = new DiscoverySectionsService([strategy], passthroughCache(), locationWith());

    await service.sections(undefined, 'US');

    expect(strategy.discover).toHaveBeenCalledWith(expect.objectContaining({ country: 'US' }));
  });

  it('lets a chosen city win over the country, as every other page does', async () => {
    const strategy = strategyReturning({
      key: 'trending',
      title: 'T',
      kind: 'events',
      items: [{ id: 'e' }],
    });
    const service = new DiscoverySectionsService(
      [strategy],
      passthroughCache(),
      locationWith('Hyderabad'),
    );

    // A US visitor who searched for Hyderabad and picked it.
    await service.sections('Hyderabad', 'US');

    const ctx = (strategy.discover as jest.Mock).mock.calls[0][0];
    expect(ctx.city).toBe('Hyderabad');
    // Sending both would ask for a Hyderabad in America and empty the page they chose.
    expect(ctx.country).toBeUndefined();
  });

  /**
   * A place with nothing in it.
   *
   * This used to answer with every city on the platform, flagged as a fallback. The owner
   * reversed that for the whole storefront - a visitor in India is never shown US events,
   * even when India has nothing - and Explore was the one page still doing it. Empty is the
   * honest answer; the page explains it and offers the city search.
   */
  describe('a place with nothing on sale', () => {
    // A strategy that only has stock in Mumbai - like the real ones, which filter by place.
    const mumbaiOnly = (key: string): DiscoveryStrategy => ({
      key,
      discover: jest.fn(async (ctx) => ({
        key,
        title: key,
        kind: 'events' as const,
        items: !ctx.city || ctx.city === 'Mumbai' ? [{ id: 'e1' }] : [],
      })),
    });

    it('stays empty rather than showing everywhere, and names the city it looked in', async () => {
      const service = new DiscoverySectionsService(
        [mumbaiOnly('trending')],
        passthroughCache(),
        locationWith('Mumbai'),
      );

      const feed = await service.sections('Pune');

      expect(feed.sections).toEqual([]);
      // Named, so the page can say "Nothing on in Pune just yet" instead of looking broken.
      expect(feed.appliedCity).toBe('Pune');
    });

    it('does not compose at all for a city we sell nothing in', async () => {
      /*
        Not every strategy filters by place, so composing anyway could return one lonely,
        unrelated shelf (a real database once returned exactly one section for Pune). A city
        with nothing on sale has nothing to show, and no strategy is asked.
      */
      const platformWide: DiscoveryStrategy = {
        key: 'organizer-spotlight',
        discover: jest.fn().mockResolvedValue({
          key: 'organizer-spotlight',
          title: 'Organizer spotlight',
          kind: 'organizers',
          items: [{ id: 'o1' }],
        }),
      };
      const service = new DiscoverySectionsService(
        [platformWide],
        passthroughCache(),
        locationWith('Mumbai'),
      );

      const feed = await service.sections('Pune');

      expect(feed.sections).toEqual([]);
      expect(platformWide.discover).not.toHaveBeenCalled();
    });

    it('applies a city it does sell in, in its stored spelling', async () => {
      const service = new DiscoverySectionsService(
        [mumbaiOnly('trending')],
        passthroughCache(),
        locationWith('Mumbai'),
      );

      const feed = await service.sections('MUMBAI');

      // A stored "Mumbai" and a typed "MUMBAI" are the same place; the strategies and the
      // page both get the spelling the picker shows.
      expect(feed.appliedCity).toBe('Mumbai');
      expect(feed.sections.map((s) => s.key)).toEqual(['trending']);
    });
  });
});
