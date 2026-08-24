import { Injectable } from '@nestjs/common';
import { AdvertisedPriceService } from '../../pricing/advertised-price.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicEventsService } from '../../events/public-events.service';
import type {
  PublicEventCardLike,
  RecommendationContext,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import {
  buildExcludeSet,
  excludeAndCap,
  fetchEventCards,
  loadSeedEvent,
} from './recommendation-cards';

/** How many top categories to draw from when there is no seed event. */
const POPULAR_CATEGORIES = 3;

/**
 * Content-based: recommends events that share the seed event's category. With
 * no seed, it falls back to events from the most popular categories (by
 * published-event count), so the section is never empty for an anonymous
 * browse. Content similarity here is category-based (the only structured
 * content signal available without a model).
 */
@Injectable()
export class ContentBasedRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'content-based';

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicEvents: PublicEventsService,
    // Threaded so a carousel never quotes a different price from the listing beside it.
    private readonly advertised: AdvertisedPriceService,
  ) {}

  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    const exclude = buildExcludeSet(ctx);
    const take = ctx.limit + exclude.size;

    if (ctx.seedEventId) {
      const seed = await loadSeedEvent(this.prisma, ctx.seedEventId);
      if (!seed) return [];
      const cards = await fetchEventCards(
        this.prisma,
        { category: { equals: seed.category, mode: 'insensitive' } },
        take,
        this.advertised,
      );
      return excludeAndCap(cards, exclude, ctx.limit);
    }

    // No seed: draw from the most popular categories.
    const categories = (await this.publicEvents.categoriesWithCounts())
      .slice(0, POPULAR_CATEGORIES)
      .map((c) => c.category);
    if (categories.length === 0) return [];
    const cards = await fetchEventCards(
      this.prisma,
      { category: { in: categories } },
      take,
      this.advertised,
    );
    return excludeAndCap(cards, exclude, ctx.limit);
  }
}
