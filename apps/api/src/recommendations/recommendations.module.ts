import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { EventsModule } from '../events/events.module';
import { RecommendationsController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
import {
  RECOMMENDATION_STRATEGIES,
  type RecommendationStrategy,
} from './strategies/recommendation-strategy.interface';
import { TrendingRecommendationStrategy } from './strategies/trending.recommendation-strategy';
import { ContentBasedRecommendationStrategy } from './strategies/content-based.recommendation-strategy';
import { OrganizerRecommendationStrategy } from './strategies/organizer.recommendation-strategy';
import { VenueRecommendationStrategy } from './strategies/venue.recommendation-strategy';
import { RecentlyViewedRecommendationStrategy } from './strategies/recently-viewed.recommendation-strategy';
import { CollaborativeRecommendationStrategy } from './strategies/collaborative.recommendation-strategy';
import { AiRecommendationStrategy } from './strategies/ai.recommendation-strategy';

/**
 * Read-only "you might also like" recommendation platform. Additive: reuses the
 * public event services (EventsModule), the shared ranking util (from
 * discovery) and the AI `RecommendationEngine` port (AiModule) — no booking,
 * payment or inventory logic is touched, and no model ships here.
 *
 * Strategies are collected under the `RECOMMENDATION_STRATEGIES` token so
 * `RecommendationService` can offer a registry keyed by strategy key; adding a
 * recommender = registering another strategy (no composer change).
 */
@Module({
  imports: [AiModule, EventsModule],
  controllers: [RecommendationsController],
  providers: [
    RecommendationService,
    TrendingRecommendationStrategy,
    ContentBasedRecommendationStrategy,
    OrganizerRecommendationStrategy,
    VenueRecommendationStrategy,
    RecentlyViewedRecommendationStrategy,
    CollaborativeRecommendationStrategy,
    AiRecommendationStrategy,
    {
      provide: RECOMMENDATION_STRATEGIES,
      useFactory: (
        trending: TrendingRecommendationStrategy,
        content: ContentBasedRecommendationStrategy,
        organizer: OrganizerRecommendationStrategy,
        venue: VenueRecommendationStrategy,
        recentlyViewed: RecentlyViewedRecommendationStrategy,
        collaborative: CollaborativeRecommendationStrategy,
        ai: AiRecommendationStrategy,
      ): RecommendationStrategy[] => [
        trending,
        content,
        organizer,
        venue,
        recentlyViewed,
        collaborative,
        ai,
      ],
      inject: [
        TrendingRecommendationStrategy,
        ContentBasedRecommendationStrategy,
        OrganizerRecommendationStrategy,
        VenueRecommendationStrategy,
        RecentlyViewedRecommendationStrategy,
        CollaborativeRecommendationStrategy,
        AiRecommendationStrategy,
      ],
    },
  ],
})
export class RecommendationsModule {}
