import { Module } from '@nestjs/common';
import {
  MARKETING_ASSISTANT,
  ORGANIZER_COPILOT,
  PRICING_ASSISTANT,
  RECOMMENDATION_ENGINE,
  REVIEW_MODERATION,
  SEARCH_RANKING,
} from './ai.ports';
import {
  NoopMarketingAssistant,
  NoopOrganizerCopilot,
  NoopPricingAssistant,
  NoopRecommendationEngine,
  NoopReviewModeration,
  NoopSearchRanking,
} from './ai.noop';

/**
 * Registers the AI extension ports and their default Noop bindings, and EXPORTS
 * the tokens so any feature module can inject a port (e.g. discovery depends on
 * `RECOMMENDATION_ENGINE`).
 *
 * The module is ALWAYS registered — the Noop bindings are always safe, so the
 * ports stay live regardless of the `aiRecommendations` feature flag. To ship a
 * real AI capability, a future plugin/PR swaps a `useClass`/`useExisting` here;
 * that is a drop-in replacement requiring no changes to any consumer.
 */
@Module({
  providers: [
    { provide: RECOMMENDATION_ENGINE, useClass: NoopRecommendationEngine },
    { provide: SEARCH_RANKING, useClass: NoopSearchRanking },
    { provide: ORGANIZER_COPILOT, useClass: NoopOrganizerCopilot },
    { provide: MARKETING_ASSISTANT, useClass: NoopMarketingAssistant },
    { provide: PRICING_ASSISTANT, useClass: NoopPricingAssistant },
    { provide: REVIEW_MODERATION, useClass: NoopReviewModeration },
  ],
  exports: [
    RECOMMENDATION_ENGINE,
    SEARCH_RANKING,
    ORGANIZER_COPILOT,
    MARKETING_ASSISTANT,
    PRICING_ASSISTANT,
    REVIEW_MODERATION,
  ],
})
export class AiModule {}
