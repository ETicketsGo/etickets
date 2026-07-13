import { Injectable } from '@nestjs/common';
import type {
  PublicEventCardLike,
  RecommendationContext,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import { TrendingRecommendationStrategy } from './trending.recommendation-strategy';

/**
 * Collaborative filtering — PLACEHOLDER / EXTENSION POINT.
 *
 * This is NOT a real collaborative-filtering implementation. Genuine CF needs a
 * user↔item interaction matrix ("people who booked X also booked Y") which is
 * not modelled/collected yet. Until that data and a model exist, this strategy
 * deliberately falls back to trending so the key stays live and callable.
 *
 * To make it real, a future PR would: (1) build the interaction matrix from
 * confirmed bookings, (2) compute item-item / user-item similarities (or bind
 * the AI `RecommendationEngine` port to a trained model), and (3) replace the
 * body below — no consumer or seam change required.
 */
@Injectable()
export class CollaborativeRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'collaborative';

  constructor(private readonly trending: TrendingRecommendationStrategy) {}

  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    // Placeholder: defer to the trending baseline until CF data/model exist.
    return this.trending.recommend(ctx);
  }
}
