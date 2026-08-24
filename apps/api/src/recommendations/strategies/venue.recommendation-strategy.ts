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
 * Venue: more upcoming events at the seed event's venue ("also at this venue").
 * "Upcoming" = has at least one session starting at/after `now`. Seed-dependent
 * — returns nothing without a seed.
 */
@Injectable()
export class VenueRecommendationStrategy implements RecommendationStrategy {
  readonly key = 'venue';

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
      { venueId: seed.venueId, sessions: { some: { startsAt: { gte: ctx.now } } } },
      ctx.limit + exclude.size,
      this.advertised,
    );
    return excludeAndCap(cards, exclude, ctx.limit);
  }
}
