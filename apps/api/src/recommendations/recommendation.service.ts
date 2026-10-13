import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { currencyForCountry } from '@eticketsgo/shared-types';
import { RECOMMENDATION_ENGINE, type RecommendationEngine } from '../ai/ai.ports';
import { AppException, ErrorCodes } from '../common/errors';
import {
  RECOMMENDATION_STRATEGIES,
  type PublicEventCardLike,
  type RecommendationContext,
  type RecommendationStrategy,
} from './strategies/recommendation-strategy.interface';
import { buildExcludeSet } from './strategies/recommendation-cards';
import { ContentBasedRecommendationStrategy } from './strategies/content-based.recommendation-strategy';
import { OrganizerRecommendationStrategy } from './strategies/organizer.recommendation-strategy';
import { VenueRecommendationStrategy } from './strategies/venue.recommendation-strategy';
import { TrendingRecommendationStrategy } from './strategies/trending.recommendation-strategy';

/**
 * Composes the recommendation strategies into the default "you might also like"
 * blend, and exposes named access to each individual strategy (a registry keyed
 * by `strategy.key`).
 *
 * The blend is deterministic and testable:
 *   • with a seed → content-based + organizer + venue (interleaved by strategy
 *     order), giving "similar / more from organizer / also at venue";
 *   • without a seed → trending.
 * Results are concatenated in strategy order, de-duplicated by event id, the
 * seed/excludes are dropped, and the whole set is routed through the AI
 * `RecommendationEngine` port for future re-ranking (Noop = identity today)
 * before being capped to `limit`.
 */
@Injectable()
export class RecommendationService {
  private readonly registry: Map<string, RecommendationStrategy>;
  /** Strategies blended when a seed event is present. */
  private readonly seededBlend: RecommendationStrategy[];

  constructor(
    @Inject(RECOMMENDATION_STRATEGIES) strategies: RecommendationStrategy[],
    @Inject(RECOMMENDATION_ENGINE) private readonly recommender: RecommendationEngine,
    private readonly content: ContentBasedRecommendationStrategy,
    private readonly organizer: OrganizerRecommendationStrategy,
    private readonly venue: VenueRecommendationStrategy,
    private readonly trending: TrendingRecommendationStrategy,
  ) {
    this.registry = new Map(strategies.map((s) => [s.key, s]));
    this.seededBlend = [this.content, this.organizer, this.venue];
  }

  /** Strategy keys available via `?strategy=`. */
  keys(): string[] {
    return [...this.registry.keys()];
  }

  /** The default blended recommendation. Deterministic; routes through the AI port. */
  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    const blend = ctx.seedEventId ? this.seededBlend : [this.trending];
    const lists = await Promise.all(blend.map((s) => s.recommend(ctx)));

    const exclude = buildExcludeSet(ctx);
    const seen = new Set<string>();
    const merged: PublicEventCardLike[] = [];
    for (const card of lists.flat()) {
      if (exclude.has(card.id) || seen.has(card.id)) continue;
      seen.add(card.id);
      merged.push(card);
    }

    // One market per list: never a card whose price is in another currency than the page's.
    const inMarket = merged.filter((card) => sameMarket(ctx.seedCountry, card));

    // Route through the AI extension port (identity under the Noop binding).
    const ranked = await this.recommender.rankExperiences(ctx.userId ?? null, inMarket);
    return ranked.slice(0, ctx.limit);
  }

  /** Run a single named strategy. Throws NOT_FOUND for an unknown key. */
  async recommendWith(key: string, ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    const strategy = this.registry.get(key);
    if (!strategy) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `Unknown recommendation strategy '${key}'.`,
        HttpStatus.NOT_FOUND,
        { available: this.keys() },
      );
    }
    return strategy.recommend(ctx);
  }
}

/**
 * Is this card sold in the seed's market? A market is the currency of the venue's country, so
 * "US" and "United States" are one. Reported by the design audit: a Boise jazz night offered
 * Hyderabad events under "You might also like", each priced in rupees, with nothing to say so.
 * No seed country (or a country with no known currency) filters nothing - an unknown market is
 * not grounds to hide every card.
 */
export function sameMarket(
  seedCountry: string | null | undefined,
  card: { venue: { country: string | null } },
): boolean {
  const seed = currencyForCountry(seedCountry);
  if (!seed) return true;
  // A card whose own market cannot be told is dropped: it could be the very mismatch this guards.
  return currencyForCountry(card.venue.country) === seed;
}
