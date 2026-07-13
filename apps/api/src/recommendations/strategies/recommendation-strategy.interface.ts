import type { PublicEventsService } from '../../events/public-events.service';

/**
 * Recommendation strategy seam.
 *
 * A RecommendationStrategy produces ONE ranked list of "you might also like"
 * event cards for a given context (a seed event, an anonymous/known user, …).
 * The composer (`RecommendationService`) depends only on this contract, never on
 * a concrete strategy, so new recommenders are added by registering another
 * strategy — mirroring the DiscoveryStrategy / InventoryStrategy seams.
 *
 * Every strategy is READ-ONLY and additive: it reuses the existing public event
 * services / Prisma reads and the shared ranking util, and never touches
 * booking, payment or inventory. There is deliberately NO model here — a future
 * real recommender binds the AI `RecommendationEngine` port (see ai.ports.ts);
 * these strategies only shape candidate sets.
 */

/**
 * The public event card shape strategies return — reused verbatim from
 * `PublicEventsService.list` so recommendations render with the existing
 * EventCard component and the `PublicEventCard` client type. No new shape.
 */
export type PublicEventCardLike = Awaited<ReturnType<PublicEventsService['list']>>['data'][number];

/** Everything a strategy needs to build its ranked list. */
export interface RecommendationContext {
  /** The signed-in user, or null/undefined for an anonymous visitor. */
  userId?: string | null;
  /** The event being viewed, if any — the "seed" the list is relative to. */
  seedEventId?: string;
  /** Event ids to exclude (already-seen / on-page). The seed is always excluded. */
  excludeEventIds?: string[];
  /**
   * Client-supplied recently-viewed event ids. The server cannot read the
   * browser's localStorage `etg_recent` store, so the recently-viewed list is
   * passed in by the client. Optional and additive; unused by the HTTP endpoint
   * today but honoured by `RecentlyViewedRecommendationStrategy`.
   */
  recentEventIds?: string[];
  /** Maximum number of cards to return. */
  limit: number;
  /** "Now" is injected so strategies are deterministic and unit-testable. */
  now: Date;
}

/** The pluggable contract every recommender implements. */
export interface RecommendationStrategy {
  /** Stable identifier, also used as the `?strategy=` selector. */
  readonly key: string;
  /** Build this strategy's ranked, seed-excluded, capped list. */
  recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]>;
}

/** DI token for the ordered array of registered strategies. */
export const RECOMMENDATION_STRATEGIES = 'recommendations.strategies';
