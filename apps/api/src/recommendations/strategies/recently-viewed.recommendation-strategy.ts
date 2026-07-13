import { Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PublicEventCardLike,
  RecommendationContext,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import { buildExcludeSet, excludeAndCap, fetchEventCards } from './recommendation-cards';
import { TrendingRecommendationStrategy } from './trending.recommendation-strategy';

/**
 * Recently-viewed: recommends events whose category matches the categories of
 * the events the visitor recently viewed.
 *
 * IMPORTANT: the server cannot read the browser's `etg_recent` localStorage
 * store, so the recently-viewed list is CLIENT-SUPPLIED via
 * `ctx.recentEventIds` (falling back to `ctx.seedEventId`). This strategy only
 * derives the *categories* of those ids server-side and finds more events in
 * them. When no recent/seed ids are supplied it degrades to trending, so it is
 * always safe to call.
 */
@Injectable()
export class RecentlyViewedRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'recently-viewed';

  constructor(
    private readonly prisma: PrismaService,
    private readonly trending: TrendingRecommendationStrategy,
  ) {}

  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    const recentIds = [
      ...(ctx.recentEventIds ?? []),
      ...(ctx.seedEventId ? [ctx.seedEventId] : []),
    ];
    if (recentIds.length === 0) return this.trending.recommend(ctx);

    const rows = await this.prisma.event.findMany({
      where: {
        id: { in: recentIds },
        status: EventStatus.PUBLISHED,
        experienceType: ExperienceType.EVENT,
      },
      select: { category: true },
    });
    const categories = [...new Set(rows.map((r) => r.category))];
    if (categories.length === 0) return this.trending.recommend(ctx);

    // Exclude the recently-viewed ids too — they've already been seen.
    const exclude = buildExcludeSet(ctx);
    for (const id of recentIds) exclude.add(id);

    const cards = await fetchEventCards(
      this.prisma,
      { category: { in: categories } },
      ctx.limit + exclude.size,
    );
    return excludeAndCap(cards, exclude, ctx.limit);
  }
}
