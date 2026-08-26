import { Inject, Injectable } from '@nestjs/common';
import {
  DISCOVERY_STRATEGIES,
  type DiscoveryContext,
  type DiscoverySection,
  type DiscoveryStrategy,
} from './strategies/discovery-strategy.interface';
import { CacheService } from '../cache/cache.service';
import { LocationService } from './location.service';

/** Short TTL: the section feed is anonymous per-city and safe to serve stale. */
const SECTIONS_CACHE_TTL_SECONDS = 45;

/**
 * Composes the registered discovery strategies into the ordered section feed.
 * Depends only on the DiscoveryStrategy contract (injected as an array), so new
 * sections are added by registering another strategy — this service is closed
 * for modification. Empty sections are dropped so the client never renders an
 * empty grid. Read-only and additive.
 */
/**
 * The section feed, plus what the filter actually did.
 *
 * `appliedCity` is what was really used — not what was asked for — and
 * `fellBackToAllCities` says why they differ. Both exist so the client never has to infer
 * from an empty array whether the city is quiet or the platform is.
 */
export interface SectionFeed {
  sections: DiscoverySection[];
  appliedCity: string | null;
  fellBackToAllCities: boolean;
}

@Injectable()
export class DiscoverySectionsService {
  constructor(
    @Inject(DISCOVERY_STRATEGIES) private readonly strategies: DiscoveryStrategy[],
    private readonly cache: CacheService,
    private readonly location: LocationService,
  ) {}

  async sections(city?: string): Promise<SectionFeed> {
    // Raw city in the key (not lowercased) so a strategy that matches city
    // case-sensitively can never be served another casing's result.
    const key = `disc:sections:${city ?? 'all'}`;
    return this.cache.getOrSet(key, SECTIONS_CACHE_TTL_SECONDS, () => this.compose(city));
  }

  private async compose(city?: string): Promise<SectionFeed> {
    if (!city) {
      return {
        sections: await this.composeFor(undefined),
        appliedCity: null,
        fellBackToAllCities: false,
      };
    }

    /*
      Whether to fall back is decided on INVENTORY, not on whether the composed feed came
      back empty — and the difference is not academic.

      Not every strategy filters by city: the organizer and venue spotlights are
      platform-wide by design. So a city with genuinely nothing on sale still produces a
      non-empty feed — one lonely shelf of organizers from a city four hundred kilometres
      away, with nothing to say why the rest of the page is missing. Judged on the array
      alone, that reads as success. This was caught against a real database, where Pune
      returned exactly one section; the stubbed strategies in the unit tests all honoured
      the city, so they never saw it.

      Asking whether the city has any published, upcoming events answers the real question,
      and answers it the same way the city picker does — so the picker cannot offer a city
      the feed then treats as empty, or vice versa.
    */
    const sellable = await this.location.cities();
    const match = sellable.find((c) => c.city.toLowerCase() === city.toLowerCase());
    if (match) {
      /*
        Strategies get the CANONICAL spelling, never the raw input.

        "MUMBAI" from a deep link and "Mumbai" from the picker are the same place, but a
        strategy that compares case-sensitively would find nothing for one of them — and
        `appliedCity` would echo back a shouted city name the picker never shows. Resolving
        to the stored spelling once, here, means every strategy and the cache key downstream
        all agree on one form.
      */
      const sections = await this.composeFor(match.city);
      // Belt and braces: a sellable city that still composes to nothing is better served by
      // everywhere than by a blank page.
      if (sections.length > 0) {
        return { sections, appliedCity: match.city, fellBackToAllCities: false };
      }
    }

    /*
      Falling back, and saying so. A silent fallback is its own lie — the customer would
      wonder why the city they picked is not being applied — so the flag travels with the
      feed and the client says "nothing in Pune yet; here is everywhere".
    */
    return {
      sections: await this.composeFor(undefined),
      appliedCity: null,
      fellBackToAllCities: true,
    };
  }

  private async composeFor(city?: string): Promise<DiscoverySection[]> {
    const ctx: DiscoveryContext = { city, now: new Date() };
    const composed = await Promise.all(this.strategies.map((s) => s.discover(ctx)));
    return composed.filter((section) => section.items.length > 0);
  }
}
