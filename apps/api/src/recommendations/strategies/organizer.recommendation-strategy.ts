import { Injectable } from '@nestjs/common';
import { AdvertisedPriceService } from '../../pricing/advertised-price.service';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PublicEventCardLike,
  RecommendationContext,
  RecommendationStrategy,
} from './recommendation-strategy.interface';
import {
  buildExcludeSet,
  excludeAndCap,
  fetchEventCards,
  loadSeedEvent,
} from './recommendation-cards';

/**
 * Organizer: more published events from the same organizer as the seed event
 * ("more from this organizer"). Seed-dependent — returns nothing without a
 * seed, so the blend simply omits it in that case.
 */
@Injectable()
export class OrganizerRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'organizer';

  constructor(
    private readonly prisma: PrismaService,
    // Threaded so a carousel never quotes a different price from the listing beside it.
    private readonly advertised: AdvertisedPriceService,
  ) {}

  async recommend(ctx: RecommendationContext): Promise<PublicEventCardLike[]> {
    if (!ctx.seedEventId) return [];
    const seed = await loadSeedEvent(this.prisma, ctx.seedEventId);
    if (!seed) return [];

    const exclude = buildExcludeSet(ctx);
    const cards = await fetchEventCards(
      this.prisma,
      { organizationId: seed.organizationId },
      ctx.limit + exclude.size,
      this.advertised,
    );
    return excludeAndCap(cards, exclude, ctx.limit);
  }
}
