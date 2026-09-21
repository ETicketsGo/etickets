import { Inject, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { PublicMoviesService } from '../movies/movies.service';
import { PublicEventsService } from '../events/public-events.service';
import { RECOMMENDATION_ENGINE, type RecommendationEngine } from '../ai/ai.ports';
import { CacheService } from '../cache/cache.service';
import { venueInScope } from './strategies/scope';

const TRENDING_PAGE_SIZE = 8;
const WEEKEND_PAGE_SIZE = 8;

/** Short TTL: the composed feed is anonymous and safe to serve slightly stale. */
const DISCOVERY_CACHE_TTL_SECONDS = 45;
const DISCOVERY_CACHE_KEY = 'disc:legacy';

/**
 * Where the visitor is browsing. City wins over country, as on every other page.
 *
 * This endpoint took no place at all, and cached ONE answer for everybody. It feeds the top of
 * Explore — Now showing, Trending, This weekend, the category chips — so those were the same
 * worldwide list whether the visitor was in Hyderabad, in the United States, or had picked a
 * city. The owner opened Explore from the United States and saw Indian shows throughout.
 * Every other list on the storefront had been scoped; this one had never been asked.
 *
 * Callers that send nothing (the mobile app today) still get everything, exactly as before.
 */
export interface DiscoveryPlace {
  city?: string;
  country?: string;
}

/**
 * Composes the unified experience-discovery payload from the existing public
 * services (no duplicated query logic) and runs the trending/now-showing lists
 * through the AI RecommendationEngine port so the extension has a real consumer.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publicMovies: PublicMoviesService,
    private readonly publicEvents: PublicEventsService,
    @Inject(RECOMMENDATION_ENGINE) private readonly recommender: RecommendationEngine,
    private readonly cache: CacheService,
  ) {}

  /** Start-of-today → end of the coming Sunday (server-local), for "this weekend". */
  private weekendWindow(now: Date): { dateFrom: Date; dateTo: Date } {
    const dateFrom = new Date(now);
    // Days until Sunday (0 = Sunday). If today is Sunday, this weekend ends today.
    const daysUntilSunday = (7 - now.getDay()) % 7;
    const dateTo = new Date(now);
    dateTo.setDate(now.getDate() + daysUntilSunday);
    dateTo.setHours(23, 59, 59, 999);
    return { dateFrom, dateTo };
  }

  async get(place: DiscoveryPlace = {}) {
    // The place is part of the key. With one key for everybody, the first visitor's answer
    // would be served to the next one wherever they were.
    const scope = place.city
      ? `city:${place.city}`
      : place.country
        ? `country:${place.country.toUpperCase()}`
        : 'all';
    return this.cache.getOrSet(`${DISCOVERY_CACHE_KEY}:${scope}`, DISCOVERY_CACHE_TTL_SECONDS, () =>
      this.compose(place),
    );
  }

  private async compose(place: DiscoveryPlace) {
    const now = new Date();
    const { dateFrom, dateTo } = this.weekendWindow(now);
    // `list` applies city over country itself, so both can be passed as they are.
    const where = { city: place.city, country: place.country };

    const [movies, trending, weekend, categoryRows] = await Promise.all([
      this.publicMovies.list(where),
      this.publicEvents.list({ page: 1, pageSize: TRENDING_PAGE_SIZE, ...where }),
      this.publicEvents.list({ page: 1, pageSize: WEEKEND_PAGE_SIZE, dateFrom, dateTo, ...where }),
      this.prisma.event.findMany({
        where: {
          status: EventStatus.PUBLISHED,
          experienceType: ExperienceType.EVENT,
          /*
            Only categories you could actually buy something in, here, now.

            A chip that leads to an empty page reads as "this platform has nothing", which is
            why the home page's chips were fixed to come from real inventory. These came from
            every published event anywhere, including ones whose shows were all over.
          */
          venue: venueInScope(place),
          sessions: { some: { startsAt: { gte: now } } },
        },
        select: { category: true },
        distinct: ['category'],
        orderBy: { category: 'asc' },
      }),
    ]);

    // Real consumers of the AI extension port: rank anonymously (userId=null).
    // With the Noop binding these return the items unchanged.
    const [nowShowing, trendingEvents] = await Promise.all([
      this.recommender.rankExperiences(null, movies),
      this.recommender.rankExperiences(null, trending.data),
    ]);

    return {
      nowShowing,
      trendingEvents,
      thisWeekend: weekend.data,
      categories: categoryRows.map((r) => r.category),
    };
  }
}
