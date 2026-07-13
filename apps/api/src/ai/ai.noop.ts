/**
 * Noop (identity) default implementations for every AI extension port.
 *
 * These keep each published extension point live and dead-code-free without any
 * model-specific logic. Every method is a safe, deterministic no-op:
 *   - ranking ports return the items unchanged (identity),
 *   - generative ports return empty output,
 *   - moderation allows everything.
 *
 * A future plugin/PR rebinds the token in `AiModule` to a real implementation;
 * that is a drop-in replacement — no consumer code changes.
 */
import { Injectable } from '@nestjs/common';
import type {
  MarketingAssistant,
  ModerationResult,
  OrganizerCopilot,
  PricingAssistant,
  RecommendationEngine,
  ReviewModeration,
  SearchRanking,
} from './ai.ports';

@Injectable()
export class NoopRecommendationEngine implements RecommendationEngine {
  async rankExperiences<T>(_userId: string | null, items: T[]): Promise<T[]> {
    return items;
  }
}

@Injectable()
export class NoopSearchRanking implements SearchRanking {
  async rank<T>(_query: string, items: T[]): Promise<T[]> {
    return items;
  }
}

@Injectable()
export class NoopOrganizerCopilot implements OrganizerCopilot {
  async suggest(_prompt: string, _context?: Record<string, unknown>): Promise<string> {
    return '';
  }
}

@Injectable()
export class NoopMarketingAssistant implements MarketingAssistant {
  async generateCopy(_brief: string, _context?: Record<string, unknown>): Promise<string[]> {
    return [];
  }
}

@Injectable()
export class NoopPricingAssistant implements PricingAssistant {
  async suggestPriceMinor(_signals: Record<string, unknown>): Promise<number | null> {
    return null;
  }
}

@Injectable()
export class NoopReviewModeration implements ReviewModeration {
  async moderate(_text: string, _context?: Record<string, unknown>): Promise<ModerationResult> {
    return { allow: true, reasons: [] };
  }
}
