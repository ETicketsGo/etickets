/**
 * AI extension interfaces (ports) + injection tokens.
 *
 * This module defines *architecture only*: the published extension points that
 * a future plugin / PR can rebind to a real, model-specific implementation.
 * There is deliberately NO model-specific logic here — only contracts.
 *
 * Each port has a matching string injection token. Consumers inject by token
 * (`@Inject(RECOMMENDATION_ENGINE)`) so the concrete binding is swappable. The
 * default binding is a Noop (identity) implementation — see `ai.noop.ts` — which
 * keeps every extension point live and dead-code-free. Binding a real impl is a
 * drop-in replacement: change the provider in `AiModule`, nothing else moves.
 */

/**
 * Ranks/personalises a set of experiences (events, movies, sessions, …) for a
 * user. `userId` is null for anonymous visitors. Implementations MUST return a
 * permutation/subset of the input items and MUST NOT mutate them; the Noop
 * returns the items unchanged.
 */
export interface RecommendationEngine {
  rankExperiences<T>(userId: string | null, items: T[]): Promise<T[]>;
}
export const RECOMMENDATION_ENGINE = 'ai.RecommendationEngine';

/**
 * Re-ranks search results for relevance to a free-text query. Returns a
 * permutation/subset of the input items; the Noop returns them unchanged.
 */
export interface SearchRanking {
  rank<T>(query: string, items: T[]): Promise<T[]>;
}
export const SEARCH_RANKING = 'ai.SearchRanking';

/**
 * Assists organizers with drafting/improving event copy, answering operational
 * questions, and suggesting next actions. `prompt` is the organizer's request;
 * `context` is arbitrary structured grounding (event data, metrics, …). Returns
 * a natural-language suggestion. The Noop returns an empty string (no advice).
 */
export interface OrganizerCopilot {
  suggest(prompt: string, context?: Record<string, unknown>): Promise<string>;
}
export const ORGANIZER_COPILOT = 'ai.OrganizerCopilot';

/**
 * Generates marketing collateral (subject lines, social/email copy, audience
 * hints) for a campaign brief. Returns generated variants. The Noop returns an
 * empty array (no variants).
 */
export interface MarketingAssistant {
  generateCopy(brief: string, context?: Record<string, unknown>): Promise<string[]>;
}
export const MARKETING_ASSISTANT = 'ai.MarketingAssistant';

/**
 * Recommends a ticket price (in minor units) for a session given demand/supply
 * signals. Returns a suggested price in minor units, or null when the assistant
 * declines to advise. The Noop returns null (defer to configured pricing).
 */
export interface PricingAssistant {
  suggestPriceMinor(signals: Record<string, unknown>): Promise<number | null>;
}
export const PRICING_ASSISTANT = 'ai.PricingAssistant';

/** Outcome of moderating a piece of user-generated content (e.g. a review). */
export interface ModerationResult {
  /** True when the content is safe to publish. */
  allow: boolean;
  /** Machine-readable reasons/labels when `allow` is false. */
  reasons: string[];
}

/**
 * Moderates user-generated content (reviews, comments) for policy compliance.
 * The Noop allows everything (empty reasons) — moderation is opt-in via a real
 * binding.
 */
export interface ReviewModeration {
  moderate(text: string, context?: Record<string, unknown>): Promise<ModerationResult>;
}
export const REVIEW_MODERATION = 'ai.ReviewModeration';
