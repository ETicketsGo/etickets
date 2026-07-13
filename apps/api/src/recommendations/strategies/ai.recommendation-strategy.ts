import { Inject, Injectable } from '@nestjs/common';
import { RECOMMENDATION_ENGINE, type RecommendationEngine } from '../../ai/ai.ports';
import type {
  PublicEventCardLike,
  RecommendationContext,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import { TrendingRecommendationStrategy } from './trending.recommendation-strategy';

/**
 * AI Recommendation Interface — a THIN ADAPTER over the published
 * `RecommendationEngine` AI port. There is deliberately NO model here: this
 * strategy builds a deterministic trending baseline and passes it through the
 * port's `rankExperiences(userId, items)` for personalised re-ranking.
 *
 * With the default Noop binding the port returns the items unchanged, so this
 * degrades to trending — a live consumer of the extension point today. Binding
 * a real model in `AiModule` upgrades every caller with no code change here.
 */
@Injectable()
export class AiRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'ai';

  constructor(
    private readonly trending: TrendingRecommendationStrategy,
    @Inject(RECOMMENDATION_ENGINE) private readonly recommender: RecommendationEngine,
  ) {}

  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    const baseline = await this.trending.recommend(ctx);
    const ranked = await this.recommender.rankExperiences(ctx.userId ?? null, baseline);
    return ranked.slice(0, ctx.limit);
  }
}
