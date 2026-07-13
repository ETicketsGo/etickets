import { Inject, Injectable } from '@nestjs/common';
import {
  DISCOVERY_STRATEGIES,
  type DiscoveryContext,
  type DiscoverySection,
  type DiscoveryStrategy,
} from './strategies/discovery-strategy.interface';
import { CacheService } from '../cache/cache.service';

/** Short TTL: the section feed is anonymous per-city and safe to serve stale. */
const SECTIONS_CACHE_TTL_SECONDS = 45;

/**
 * Composes the registered discovery strategies into the ordered section feed.
 * Depends only on the DiscoveryStrategy contract (injected as an array), so new
 * sections are added by registering another strategy — this service is closed
 * for modification. Empty sections are dropped so the client never renders an
 * empty grid. Read-only and additive.
 */
@Injectable()
export class DiscoverySectionsService {
  constructor(
    @Inject(DISCOVERY_STRATEGIES) private readonly strategies: DiscoveryStrategy[],
    private readonly cache: CacheService,
  ) {}

  async sections(city?: string): Promise<{ sections: DiscoverySection[] }> {
    // Raw city in the key (not lowercased) so a strategy that matches city
    // case-sensitively can never be served another casing's result.
    const key = `disc:sections:${city ?? 'all'}`;
    return this.cache.getOrSet(key, SECTIONS_CACHE_TTL_SECONDS, () => this.compose(city));
  }

  private async compose(city?: string): Promise<{ sections: DiscoverySection[] }> {
    const ctx: DiscoveryContext = { city, now: new Date() };
    const composed = await Promise.all(this.strategies.map((s) => s.discover(ctx)));
    return { sections: composed.filter((section) => section.items.length > 0) };
  }
}
