import type { RecommendationEngine } from '../../ai/ai.ports';
import type {
  PublicEventCardLike,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import { TrendingRecommendationStrategy } from './trending.recommendation-strategy';
import { ContentBasedRecommendationStrategy } from './content-based.recommendation-strategy';
import { OrganizerRecommendationStrategy } from './organizer.recommendation-strategy';
import { VenueRecommendationStrategy } from './venue.recommendation-strategy';
import { RecentlyViewedRecommendationStrategy } from './recently-viewed.recommendation-strategy';
import { CollaborativeRecommendationStrategy } from './collaborative.recommendation-strategy';
import { AiRecommendationStrategy } from './ai.recommendation-strategy';

const NOW = new Date('2026-07-13T12:00:00.000Z');

const card = (id: string): PublicEventCardLike => ({
  id,
  title: `Event ${id}`,
  slug: `event-${id}`,
  category: 'Music',
  venue: { name: 'Hall', city: 'BLR', country: 'IN' },
  organizer: 'Org',
  nextSessionAt: NOW,
  fromPriceMinor: 10000,
  currency: 'INR',
});

const ids = (cards: PublicEventCardLike[]) => cards.map((c) => c.id);

/** Assert a strategy's output is well-formed: excludes the seed and respects limit. */
function expectWellFormed(cards: PublicEventCardLike[], seedId: string | undefined, limit: number) {
  expect(cards.length).toBeLessThanOrEqual(limit);
  if (seedId) expect(ids(cards)).not.toContain(seedId);
  for (const c of cards) {
    expect(typeof c.id).toBe('string');
    expect(typeof c.title).toBe('string');
    expect(c.venue).toBeDefined();
  }
}

describe('TrendingRecommendationStrategy', () => {
  it('returns ranked cards, excludes the seed, and caps to limit', async () => {
    const publicEvents = {
      list: jest.fn().mockResolvedValue({ data: [card('e1'), card('e2'), card('e3')], meta: {} }),
    };
    const prisma = { booking: { groupBy: jest.fn().mockResolvedValue([]) } };
    const strategy = new TrendingRecommendationStrategy(prisma as never, publicEvents as never);

    const out = await strategy.recommend({ seedEventId: 'e1', limit: 2, now: NOW });

    expect(ids(out)).toEqual(['e2', 'e3']);
    expectWellFormed(out, 'e1', 2);
  });
});

describe('ContentBasedRecommendationStrategy', () => {
  it('recommends same-category events for a seed, excluding the seed', async () => {
    const prisma = {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'seed', category: 'Music', organizationId: 'o', venueId: 'v' }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'seed',
            title: 'S',
            slug: 's',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
          {
            id: 'e1',
            title: 'E1',
            slug: 'e1',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
          {
            id: 'e2',
            title: 'E2',
            slug: 'e2',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
        ]),
      },
    };
    const publicEvents = { categoriesWithCounts: jest.fn() };
    const strategy = new ContentBasedRecommendationStrategy(prisma as never, publicEvents as never);

    const out = await strategy.recommend({ seedEventId: 'seed', limit: 5, now: NOW });

    expect(ids(out)).toEqual(['e1', 'e2']);
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: { equals: 'Music', mode: 'insensitive' } }),
      }),
    );
    expectWellFormed(out, 'seed', 5);
  });

  it('falls back to popular categories when there is no seed', async () => {
    const prisma = {
      event: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            title: 'E1',
            slug: 'e1',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
        ]),
      },
    };
    const publicEvents = {
      categoriesWithCounts: jest.fn().mockResolvedValue([
        { category: 'Music', count: 9 },
        { category: 'Comedy', count: 3 },
      ]),
    };
    const strategy = new ContentBasedRecommendationStrategy(prisma as never, publicEvents as never);

    const out = await strategy.recommend({ limit: 5, now: NOW });

    expect(publicEvents.categoriesWithCounts).toHaveBeenCalled();
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: { in: ['Music', 'Comedy'] } }),
      }),
    );
    expect(ids(out)).toEqual(['e1']);
  });
});

describe('OrganizerRecommendationStrategy', () => {
  it('returns nothing without a seed', async () => {
    const prisma = { event: { findUnique: jest.fn(), findMany: jest.fn() } };
    const strategy = new OrganizerRecommendationStrategy(prisma as never);

    const out = await strategy.recommend({ limit: 5, now: NOW });

    expect(out).toEqual([]);
    expect(prisma.event.findUnique).not.toHaveBeenCalled();
  });

  it('recommends more events from the seed organizer, excluding the seed', async () => {
    const prisma = {
      event: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'seed',
          category: 'Music',
          organizationId: 'org-1',
          venueId: 'v',
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'seed',
            title: 'S',
            slug: 's',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
          {
            id: 'e9',
            title: 'E9',
            slug: 'e9',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
        ]),
      },
    };
    const strategy = new OrganizerRecommendationStrategy(prisma as never);

    const out = await strategy.recommend({ seedEventId: 'seed', limit: 5, now: NOW });

    expect(ids(out)).toEqual(['e9']);
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) }),
    );
    expectWellFormed(out, 'seed', 5);
  });
});

describe('VenueRecommendationStrategy', () => {
  it('recommends upcoming events at the seed venue, excluding the seed', async () => {
    const prisma = {
      event: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'seed',
          category: 'Music',
          organizationId: 'o',
          venueId: 'ven-1',
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e4',
            title: 'E4',
            slug: 'e4',
            category: 'Music',
            venue: {},
            organization: { name: 'O' },
            sessions: [],
          },
        ]),
      },
    };
    const strategy = new VenueRecommendationStrategy(prisma as never);

    const out = await strategy.recommend({ seedEventId: 'seed', limit: 3, now: NOW });

    expect(ids(out)).toEqual(['e4']);
    const where = prisma.event.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ venueId: 'ven-1' });
    expect(where.sessions.some.startsAt.gte).toEqual(NOW);
  });
});

describe('RecentlyViewedRecommendationStrategy', () => {
  it('falls back to trending when no recent/seed ids are supplied', async () => {
    const trending = { recommend: jest.fn().mockResolvedValue([card('t1')]) };
    const prisma = { event: { findMany: jest.fn() } };
    const strategy = new RecentlyViewedRecommendationStrategy(prisma as never, trending as never);

    const out = await strategy.recommend({ limit: 5, now: NOW });

    expect(ids(out)).toEqual(['t1']);
    expect(trending.recommend).toHaveBeenCalledTimes(1);
    expect(prisma.event.findMany).not.toHaveBeenCalled();
  });

  it('recommends same-category events from client-supplied recent ids, excluding them', async () => {
    const prisma = {
      event: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ category: 'Jazz' }])
          .mockResolvedValueOnce([
            {
              id: 'r1',
              title: 'R1',
              slug: 'r1',
              category: 'Jazz',
              venue: {},
              organization: { name: 'O' },
              sessions: [],
            },
            {
              id: 'n1',
              title: 'N1',
              slug: 'n1',
              category: 'Jazz',
              venue: {},
              organization: { name: 'O' },
              sessions: [],
            },
          ]),
      },
    };
    const trending = { recommend: jest.fn() };
    const strategy = new RecentlyViewedRecommendationStrategy(prisma as never, trending as never);

    const out = await strategy.recommend({ recentEventIds: ['r1'], limit: 5, now: NOW });

    expect(ids(out)).toEqual(['n1']); // r1 is excluded as already-viewed
    expect(trending.recommend).not.toHaveBeenCalled();
  });
});

describe('CollaborativeRecommendationStrategy (placeholder)', () => {
  it('delegates to trending until a real CF model exists', async () => {
    const trending = { recommend: jest.fn().mockResolvedValue([card('t1'), card('t2')]) };
    const strategy = new CollaborativeRecommendationStrategy(trending as never);

    const out = await strategy.recommend({ limit: 5, now: NOW });

    expect(ids(out)).toEqual(['t1', 't2']);
    expect(trending.recommend).toHaveBeenCalledTimes(1);
  });
});

describe('AiRecommendationStrategy', () => {
  it('delegates the trending baseline through the RecommendationEngine port', async () => {
    const trending = { recommend: jest.fn().mockResolvedValue([card('a1'), card('a2')]) };
    const rankExperiences = jest.fn((_userId: string | null, items: unknown[]) =>
      Promise.resolve(items),
    );
    const recommender = { rankExperiences } as unknown as RecommendationEngine;
    const strategy = new AiRecommendationStrategy(trending as never, recommender);

    const out = await strategy.recommend({ userId: 'u1', limit: 5, now: NOW });

    expect(rankExperiences).toHaveBeenCalledTimes(1);
    expect(rankExperiences).toHaveBeenCalledWith('u1', expect.any(Array));
    expect(ids(out)).toEqual(['a1', 'a2']);
  });

  it('passes null userId for anonymous callers', async () => {
    const trending = { recommend: jest.fn().mockResolvedValue([card('a1')]) };
    const rankExperiences = jest.fn((_userId: string | null, items: unknown[]) =>
      Promise.resolve(items),
    );
    const strategy = new AiRecommendationStrategy(trending as never, { rankExperiences } as never);

    await strategy.recommend({ limit: 5, now: NOW });

    expect(rankExperiences).toHaveBeenCalledWith(null, expect.any(Array));
  });
});

// Sanity: every strategy exposes a stable, unique key.
describe('strategy keys', () => {
  it('are the documented set', () => {
    const keys: string[] = (
      [
        new TrendingRecommendationStrategy({} as never, {} as never),
        new ContentBasedRecommendationStrategy({} as never, {} as never),
        new OrganizerRecommendationStrategy({} as never),
        new VenueRecommendationStrategy({} as never),
        new RecentlyViewedRecommendationStrategy({} as never, {} as never),
        new CollaborativeRecommendationStrategy({} as never),
        new AiRecommendationStrategy({} as never, {} as never),
      ] as RecommendationStrategy[]
    ).map((s) => s.key);
    expect(keys).toEqual([
      'trending',
      'content-based',
      'organizer',
      'venue',
      'recently-viewed',
      'collaborative',
      'ai',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
