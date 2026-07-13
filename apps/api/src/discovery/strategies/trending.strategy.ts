import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicEventsService } from '../../events/public-events.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';
import { DEFAULT_RANK_WEIGHTS } from './ranking';
import { rankedEventCards } from './ranked-events';

const LIMIT = 8;

/** Events ranked by popularity blended with how soon they start. */
@Injectable()
export class TrendingStrategy implements DiscoveryStrategy {
  readonly key = 'trending';

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicEvents: PublicEventsService,
  ) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const items = await rankedEventCards(
      this.prisma,
      this.publicEvents,
      ctx,
      DEFAULT_RANK_WEIGHTS,
      LIMIT,
    );
    return { key: this.key, title: 'Trending now', kind: 'events', items };
  }
}
