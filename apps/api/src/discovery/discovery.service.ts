import { Inject, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { PublicMoviesService } from '../movies/movies.service';
import { PublicEventsService } from '../events/public-events.service';
import { RECOMMENDATION_ENGINE, type RecommendationEngine } from '../ai/ai.ports';
import { CacheService } from '../cache/cache.service';

const TRENDING_PAGE_SIZE = 8;
const WEEKEND_PAGE_SIZE = 8;

/** Short TTL: the composed feed is anonymous and safe to serve slightly stale. */
const DISCOVERY_CACHE_TTL_SECONDS = 45;
const DISCOVERY_CACHE_KEY = 'disc:legacy';

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

  async get() {
    return this.cache.getOrSet(DISCOVERY_CACHE_KEY, DISCOVERY_CACHE_TTL_SECONDS, () =>
      this.compose(),
    );
  }

  private async compose() {
    const now = new Date();
    const { dateFrom, dateTo } = this.weekendWindow(now);

    const [movies, trending, weekend, categoryRows] = await Promise.all([
      this.publicMovies.list({}),
      this.publicEvents.list({ page: 1, pageSize: TRENDING_PAGE_SIZE }),
      this.publicEvents.list({ page: 1, pageSize: WEEKEND_PAGE_SIZE, dateFrom, dateTo }),
      this.prisma.event.findMany({
        where: { status: EventStatus.PUBLISHED, experienceType: ExperienceType.EVENT },
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
