import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicEventsService } from '../../events/public-events.service';
import { DEFAULT_RANK_WEIGHTS } from '../../discovery/strategies/ranking';
import { rankedEventCards } from '../../discovery/strategies/ranked-events';
import type {
  PublicEventCardLike,
  RecommendationContext,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import { buildExcludeSet, excludeAndCap } from './recommendation-cards';

/**
 * Trending: the deterministically-ranked trending events (popularity blended
 * with soonness), reusing the discovery `rankedEventCards` util so the
 * popularity signal is computed one way only. Seed-independent — a safe default
 * when there is no seed event.
 */
@Injectable()
export class TrendingRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'trending';

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicEvents: PublicEventsService,
  ) {}

  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    const exclude = buildExcludeSet(ctx);
    const ranked = await rankedEventCards(
      this.prisma,
      this.publicEvents,
      { now: ctx.now },
      DEFAULT_RANK_WEIGHTS,
      ctx.limit + exclude.size,
    );
    return excludeAndCap(ranked, exclude, ctx.limit);
  }
}
