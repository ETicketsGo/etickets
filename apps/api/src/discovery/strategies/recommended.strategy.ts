import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicEventsService } from '../../events/public-events.service';
import { RECOMMENDATION_ENGINE, type RecommendationEngine } from '../../ai/ai.ports';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';
import { DEFAULT_RANK_WEIGHTS } from './ranking';
import { rankedEventCards } from './ranked-events';

const LIMIT = 8;

/**
 * Recommended-for-you: the deterministically-ranked trending events passed
 * through the AI RecommendationEngine port so a future model can re-rank them.
 * With the Noop binding the items pass through unchanged, so this degrades to
 * "trending" — a real consumer of the extension point today.
 */
@Injectable()
export class RecommendedStrategy implements DiscoveryStrategy {
  readonly key = 'recommended';

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicEvents: PublicEventsService,
    @Inject(RECOMMENDATION_ENGINE) private readonly recommender: RecommendationEngine,
  ) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const baseline = await rankedEventCards(
      this.prisma,
      this.publicEvents,
      ctx,
      DEFAULT_RANK_WEIGHTS,
      LIMIT,
    );
    // Anonymous ranking (userId = null) — discovery has no authenticated user.
    const items = await this.recommender.rankExperiences(null, baseline);
    return { key: this.key, title: 'Recommended for you', kind: 'events', items };
  }
}
