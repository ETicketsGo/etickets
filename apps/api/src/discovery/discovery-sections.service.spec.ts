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

  /**
   * A city with nothing in it.
   *
   * The reason this matters more than it looks: the platform launches city by city, so for
   * a long while most cities will be empty. Filtering to one and rendering the empty array
   * that comes back tells the customer the whole platform has nothing on sale.
   */
  describe('a city with nothing on sale', () => {
    // A strategy that only has stock in Mumbai — like the real ones, which filter by city.
    const mumbaiOnly = (key: string): DiscoveryStrategy => ({
      key,
      discover: jest.fn(async (ctx) => ({
        key,
        title: key,
        kind: 'events' as const,
        items: !ctx.city || ctx.city === 'Mumbai' ? [{ id: 'e1' }] : [],
      })),
    });

    it('shows everywhere instead of an empty page, and says that is what it did', async () => {
      const service = new DiscoverySectionsService(
        [mumbaiOnly('trending')],
        passthroughCache(),
        locationWith('Mumbai'),
      );

      const feed = await service.sections('Pune');

      expect(feed.sections.map((s) => s.key)).toEqual(['trending']);
      // Both flags matter. Silently ignoring the filter would be its own lie — the customer
      // would wonder why the city they picked is not being applied.
      expect(feed.fellBackToAllCities).toBe(true);
      expect(feed.appliedCity).toBeNull();
    });

    it('does not fall back when the city does have something', async () => {
      const service = new DiscoverySectionsService(
        [mumbaiOnly('trending')],
        passthroughCache(),
        locationWith('Mumbai'),
      );

      const feed = await service.sections('Mumbai');

      expect(feed.fellBackToAllCities).toBe(false);
      expect(feed.appliedCity).toBe('Mumbai');
    });

    it('reports an empty platform as empty rather than as a fallback', async () => {
      // Nothing anywhere is a different situation from nothing here, and conflating them
      // would have the client apologise for a filter that is not the problem.
      const nothing: DiscoveryStrategy = {
        key: 'x',
        discover: jest.fn().mockResolvedValue({ key: 'x', title: 'X', kind: 'events', items: [] }),
      };
      const service = new DiscoverySectionsService([nothing], passthroughCache(), locationWith());

      const feed = await service.sections('Pune');

      expect(feed.sections).toEqual([]);
      expect(feed.fellBackToAllCities).toBe(true);
    });

    it('falls back on a city with no inventory even when a section still has items', async () => {
      /*
        The regression that only a real database exposed.

        The organizer and venue spotlights are platform-wide by design, so a city with
        nothing on sale still returns one populated shelf — of organizers from somewhere
        else entirely. Judged on "did the array come back empty" that reads as a working
        filter; the customer sees one lonely row and no explanation for the missing page.
      */
      const platformWide: DiscoveryStrategy = {
        key: 'organizer-spotlight',
        discover: jest.fn().mockResolvedValue({
          key: 'organizer-spotlight',
          title: 'Organizer spotlight',
          kind: 'events',
          items: [{ id: 'o1' }],
        }),
      };
      const service = new DiscoverySectionsService(
        [platformWide],
        passthroughCache(),
        locationWith('Mumbai'), // Pune is not sellable
      );

      const feed = await service.sections('Pune');

      expect(feed.fellBackToAllCities).toBe(true);
      expect(feed.appliedCity).toBeNull();
    });

    it('matches the city case-insensitively, as the picker and the API both do', async () => {
      const service = new DiscoverySectionsService(
        [mumbaiOnly('trending')],
        passthroughCache(),
        locationWith('Mumbai'),
      );
      // A stored "Mumbai" and a chosen "mumbai" are the same place; treating them as
      // different would make the header chip and the feed disagree.
      expect((await service.sections('MUMBAI')).fellBackToAllCities).toBe(false);
    });
  });
});
