import { Inject, Injectable } from '@nestjs/common';
import {
  DISCOVERY_STRATEGIES,
  type DiscoveryContext,
  type DiscoverySection,
  type DiscoveryStrategy,
} from './strategies/discovery-strategy.interface';

/**
 * Composes the registered discovery strategies into the ordered section feed.
 * Depends only on the DiscoveryStrategy contract (injected as an array), so new
 * sections are added by registering another strategy — this service is closed
 * for modification. Empty sections are dropped so the client never renders an
 * empty grid. Read-only and additive.
 */
@Injectable()
export class DiscoverySectionsService {
  constructor(@Inject(DISCOVERY_STRATEGIES) private readonly strategies: DiscoveryStrategy[]) {}

  async sections(city?: string): Promise<{ sections: DiscoverySection[] }> {
    const ctx: DiscoveryContext = { city, now: new Date() };
    const composed = await Promise.all(this.strategies.map((s) => s.discover(ctx)));
    return { sections: composed.filter((section) => section.items.length > 0) };
  }
}
