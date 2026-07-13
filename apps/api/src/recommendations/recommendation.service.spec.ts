import { RecommendationService } from './recommendation.service';
import type {
  PublicEventCardLike,
  RecommendationStrategy,
} from './strategies/recommendation-strategy.interface';
import type { RecommendationEngine } from '../ai/ai.ports';

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

/** A stub strategy that returns a fixed list. */
const stub = (key: string, out: PublicEventCardLike[]): RecommendationStrategy => ({
  key,
  recommend: jest.fn().mockResolvedValue(out),
});

/** Identity recommendation port (mirrors the Noop binding). */
const identityPort = (): RecommendationEngine => {
  const rankExperiences = jest.fn((_userId: string | null, items: unknown[]) =>
    Promise.resolve(items),
  );
  return { rankExperiences } as unknown as RecommendationEngine;
};

function build(opts: {
  content?: RecommendationStrategy;
  organizer?: RecommendationStrategy;
  venue?: RecommendationStrategy;
  trending?: RecommendationStrategy;
  port?: RecommendationEngine;
  extra?: RecommendationStrategy[];
}) {
  const content = opts.content ?? stub('content-based', []);
  const organizer = opts.organizer ?? stub('organizer', []);
  const venue = opts.venue ?? stub('venue', []);
  const trending = opts.trending ?? stub('trending', []);
  const port = opts.port ?? identityPort();
  const registry = [trending, content, organizer, venue, ...(opts.extra ?? [])];
  const service = new RecommendationService(
    registry,
    port,
    content as never,
    organizer as never,
    venue as never,
    trending as never,
  );
  return { service, content, organizer, venue, trending, port };
}

describe('RecommendationService.recommend', () => {
  it('blends content + organizer + venue for a seed, de-duped and seed-excluded', async () => {
    const content = stub('content-based', [card('c1'), card('c2')]);
    const organizer = stub('organizer', [card('c2'), card('c3')]); // c2 is a cross-strategy dupe
    const venue = stub('venue', [card('seed'), card('c4')]); // seed must be dropped
    const { service } = build({ content, organizer, venue });

    const out = await service.recommend({ seedEventId: 'seed', limit: 10, now: NOW });

    expect(ids(out)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('caps the blended result to limit', async () => {
    const content = stub('content-based', [card('c1'), card('c2'), card('c3')]);
    const { service } = build({ content });

    const out = await service.recommend({ seedEventId: 'seed', limit: 2, now: NOW });

    expect(ids(out)).toEqual(['c1', 'c2']);
  });

  it('honours explicit excludeEventIds', async () => {
    const content = stub('content-based', [card('c1'), card('c2'), card('c3')]);
    const { service } = build({ content });

    const out = await service.recommend({
      seedEventId: 'seed',
      excludeEventIds: ['seed', 'c2'],
      limit: 10,
      now: NOW,
    });

    expect(ids(out)).toEqual(['c1', 'c3']);
  });

  it('uses trending (not the seeded blend) when there is no seed', async () => {
    const trending = stub('trending', [card('t1'), card('t2')]);
    const content = stub('content-based', [card('c1')]);
    const { service } = build({ trending, content });

    const out = await service.recommend({ limit: 10, now: NOW });

    expect(ids(out)).toEqual(['t1', 't2']);
    expect(trending.recommend).toHaveBeenCalledTimes(1);
    expect(content.recommend).not.toHaveBeenCalled();
  });

  it('routes the merged set through the RecommendationEngine port before capping', async () => {
    const content = stub('content-based', [card('c1'), card('c2'), card('c3')]);
    // Port reverses order to prove it is applied ahead of the limit cap.
    const rankExperiences = jest.fn((_u: string | null, items: unknown[]) =>
      Promise.resolve([...items].reverse()),
    );
    const port = { rankExperiences } as unknown as RecommendationEngine;
    const { service } = build({ content, port });

    const out = await service.recommend({ seedEventId: 'seed', userId: 'u1', limit: 2, now: NOW });

    expect(rankExperiences).toHaveBeenCalledWith('u1', expect.any(Array));
    expect(ids(out)).toEqual(['c3', 'c2']); // reversed, then capped to 2
  });
});

describe('RecommendationService.recommendWith', () => {
  it('runs the named single strategy', async () => {
    const trending = stub('trending', [card('t1')]);
    const { service } = build({ trending });

    const out = await service.recommendWith('trending', { limit: 5, now: NOW });

    expect(ids(out)).toEqual(['t1']);
    expect(trending.recommend).toHaveBeenCalledTimes(1);
  });

  it('exposes the registered strategy keys', () => {
    const { service } = build({ extra: [stub('ai', [])] });
    expect(service.keys()).toContain('ai');
    expect(service.keys()).toEqual(expect.arrayContaining(['trending', 'content-based']));
  });

  it('throws NOT_FOUND for an unknown strategy key', async () => {
    const { service } = build({});
    await expect(service.recommendWith('nope', { limit: 5, now: NOW })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
