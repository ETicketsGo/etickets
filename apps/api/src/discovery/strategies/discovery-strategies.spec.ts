import type { RecommendationEngine } from '../../ai/ai.ports';
import { TrendingStrategy } from './trending.strategy';
import { PopularStrategy } from './popular.strategy';
import { WeekendStrategy, weekendWindow } from './weekend.strategy';
import { NewReleasesStrategy } from './new-releases.strategy';
import { NearbyStrategy } from './nearby.strategy';
import { OrganizerSpotlightStrategy } from './organizer-spotlight.strategy';
import { VenueSpotlightStrategy } from './venue-spotlight.strategy';
import { RecommendedStrategy } from './recommended.strategy';

const NOW = new Date('2026-07-13T12:00:00.000Z');

const eventCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Event ${id}`,
  slug: `event-${id}`,
  category: 'Music',
  venue: { name: 'Hall', city: 'BLR', country: 'IN' },
  organizer: 'Org',
  nextSessionAt: null as Date | string | null,
  fromPriceMinor: 10000,
  currency: 'INR',
  ...extra,
});

const movieCard = (id: string) => ({
  id,
  title: `Movie ${id}`,
  slug: `movie-${id}`,
  posterUrl: null,
  certificate: 'UA',
  language: 'en',
  genres: ['drama'],
  runtimeMinutes: 120,
});

describe('TrendingStrategy', () => {
  it('returns a well-formed events section ranked by the blended score', async () => {
    const publicEvents = {
      list: jest.fn().mockResolvedValue({ data: [eventCard('e1'), eventCard('e2')], meta: {} }),
    };
    const prisma = {
      booking: {
        groupBy: jest.fn().mockResolvedValue([{ eventId: 'e2', _count: { _all: 9 } }]),
      },
    };
    const strategy = new TrendingStrategy(prisma as never, publicEvents as never);

    const section = await strategy.discover({ now: NOW });

    expect(section).toMatchObject({ key: 'trending', kind: 'events', title: expect.any(String) });
    // e2 has bookings, e1 has none → e2 ranks first.
    expect((section.items as { id: string }[]).map((i) => i.id)).toEqual(['e2', 'e1']);
  });
});

describe('PopularStrategy', () => {
  it('orders events purely by confirmed-booking count', async () => {
    const publicEvents = {
      list: jest
        .fn()
        .mockResolvedValue({ data: [eventCard('e1'), eventCard('e2'), eventCard('e3')], meta: {} }),
    };
    const prisma = {
      booking: {
        groupBy: jest.fn().mockResolvedValue([
          { eventId: 'e1', _count: { _all: 3 } },
          { eventId: 'e3', _count: { _all: 12 } },
        ]),
      },
    };
    const strategy = new PopularStrategy(prisma as never, publicEvents as never);

    const section = await strategy.discover({ now: NOW });

    expect(section.key).toBe('popular');
    expect((section.items as { id: string }[]).map((i) => i.id)).toEqual(['e3', 'e1', 'e2']);
  });
});

describe('weekendWindow', () => {
  it('spans the coming Saturday 00:00 → Sunday 23:59 for a mid-week day', () => {
    const wed = new Date('2026-07-15T09:00:00'); // Wednesday (local)
    const { dateFrom, dateTo } = weekendWindow(wed);
    expect(dateFrom.getDay()).toBe(6); // Saturday
    expect(dateTo.getDay()).toBe(0); // Sunday
    expect(dateTo.getTime()).toBeGreaterThan(dateFrom.getTime());
  });
});

describe('WeekendStrategy', () => {
  it('lists events filtered to the weekend window', async () => {
    const publicEvents = {
      list: jest.fn().mockResolvedValue({ data: [eventCard('e1')], meta: {} }),
    };
    const strategy = new WeekendStrategy(publicEvents as never);

    const section = await strategy.discover({ now: NOW });

    expect(section).toMatchObject({ key: 'weekend', kind: 'events' });
    const args = publicEvents.list.mock.calls[0][0];
    expect(args.dateFrom).toBeInstanceOf(Date);
    expect(args.dateTo).toBeInstanceOf(Date);
  });
});

describe('NewReleasesStrategy', () => {
  it('returns a movies section from PublicMoviesService.list', async () => {
    const publicMovies = { list: jest.fn().mockResolvedValue([movieCard('m1'), movieCard('m2')]) };
    const strategy = new NewReleasesStrategy(publicMovies as never);

    const section = await strategy.discover({ now: NOW });

    expect(section).toMatchObject({ key: 'new-releases', kind: 'movies' });
    expect(section.items).toHaveLength(2);
  });
});

describe('NearbyStrategy', () => {
  it('is empty (and calls no query) without a city', async () => {
    const publicEvents = { list: jest.fn() };
    const strategy = new NearbyStrategy(publicEvents as never);

    const section = await strategy.discover({ now: NOW });

    expect(section.items).toEqual([]);
    expect(publicEvents.list).not.toHaveBeenCalled();
  });

  it('filters events by city when a city is provided', async () => {
    const publicEvents = {
      list: jest.fn().mockResolvedValue({ data: [eventCard('e1')], meta: {} }),
    };
    const strategy = new NearbyStrategy(publicEvents as never);

    const section = await strategy.discover({ now: NOW, city: 'BLR' });

    expect(section.kind).toBe('events');
    expect(section.items).toHaveLength(1);
    expect(publicEvents.list).toHaveBeenCalledWith(expect.objectContaining({ city: 'BLR' }));
  });
});

describe('OrganizerSpotlightStrategy', () => {
  it('maps approved organizations to verified spotlight items with counts', async () => {
    const prisma = {
      organization: {
        findMany: jest.fn().mockResolvedValue([{ id: 'o1', name: 'Acme', _count: { events: 4 } }]),
      },
    };
    const strategy = new OrganizerSpotlightStrategy(prisma as never);

    const section = await strategy.discover({ now: NOW });

    expect(section).toMatchObject({ key: 'organizer-spotlight', kind: 'organizers' });
    expect(section.items[0]).toEqual({ id: 'o1', name: 'Acme', verified: true, eventCount: 4 });
  });
});

describe('VenueSpotlightStrategy', () => {
  it('maps venues with published events to spotlight items', async () => {
    const prisma = {
      venue: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'v1', name: 'Arena', city: 'BLR', country: 'IN', _count: { events: 2 } },
          ]),
      },
    };
    const strategy = new VenueSpotlightStrategy(prisma as never);

    const section = await strategy.discover({ now: NOW });

    expect(section).toMatchObject({ key: 'venue-spotlight', kind: 'venues' });
    expect(section.items[0]).toEqual({
      id: 'v1',
      name: 'Arena',
      city: 'BLR',
      country: 'IN',
      eventCount: 2,
    });
  });
});

describe('RecommendedStrategy', () => {
  it('routes the ranked trending baseline through the RecommendationEngine port', async () => {
    const publicEvents = {
      list: jest.fn().mockResolvedValue({ data: [eventCard('e1'), eventCard('e2')], meta: {} }),
    };
    const prisma = { booking: { groupBy: jest.fn().mockResolvedValue([]) } };
    const rankExperiences = jest.fn((_userId: string | null, items: unknown[]) =>
      Promise.resolve(items),
    );
    const recommender = { rankExperiences } as unknown as RecommendationEngine;
    const strategy = new RecommendedStrategy(prisma as never, publicEvents as never, recommender);

    const section = await strategy.discover({ now: NOW });

    expect(section).toMatchObject({ key: 'recommended', kind: 'events' });
    expect(rankExperiences).toHaveBeenCalledTimes(1);
    expect(rankExperiences).toHaveBeenCalledWith(null, expect.any(Array));
  });
});
