import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicEventsService } from '../../events/public-events.service';
import {
  DiscoveryContext,
  DiscoverySection,
  DiscoveryStrategy,
} from './discovery-strategy.interface';
import { rankedEventCards } from './ranked-events';

const LIMIT = 8;
/** Popular = ranked purely by confirmed-booking count (soonness ignored). */
const POPULAR_WEIGHTS = { popularity: 1, soonness: 0 };

/** Events ordered by confirmed-booking count. */
@Injectable()
export class PopularStrategy implements DiscoveryStrategy {
  readonly key = 'popular';

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicEvents: PublicEventsService,
  ) {}

  async discover(ctx: DiscoveryContext): Promise<DiscoverySection> {
    const items = await rankedEventCards(
      this.prisma,
      this.publicEvents,
      ctx,
      POPULAR_WEIGHTS,
      LIMIT,
    );
    return { key: this.key, title: 'Most popular', kind: 'events', items };
  }
}
