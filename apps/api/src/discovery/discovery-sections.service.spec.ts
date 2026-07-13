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
    const service = new DiscoverySectionsService([strategy], passthroughCache());

    await service.sections('BLR');

    expect(strategy.discover).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'BLR', now: expect.any(Date) }),
    );
  });

  it('returns an empty feed when every section is empty', async () => {
    const empty: DiscoverySection = { key: 'x', title: 'X', kind: 'events', items: [] };
    const service = new DiscoverySectionsService([strategyReturning(empty)], passthroughCache());

    const { sections } = await service.sections();

    expect(sections).toEqual([]);
  });
});
