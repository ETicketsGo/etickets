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
 * The section feed, plus the place it was actually built for.
 *
 * `appliedCity` is the city the feed is filtered to, in its stored spelling — or null when it
 * is filtered by country, or by nothing. The client uses it to name the place in an empty
 * state ("Nothing on in Pune just yet") without having to guess why the page is empty.
 *
 * ── THERE IS NO FALLBACK ANY MORE ──────────────────────────────────────────────────
 * This used to carry `fellBackToAllCities`: a city with nothing on sale was answered with
 * every city on the platform, flagged so the client could say so. That is the rule the owner
 * reversed for the whole storefront — "if the user is in India we should not show US events
 * even if we have no events in India" — and Explore was the one page still doing it. An
 * empty place gets an empty feed, and the page explains it and offers the city search.
 */
export interface SectionFeed {
  sections: DiscoverySection[];
  appliedCity: string | null;
}

@Injectable()
export class DiscoverySectionsService {
  constructor(
    @Inject(DISCOVERY_STRATEGIES) private readonly strategies: DiscoveryStrategy[],
    private readonly cache: CacheService,
    private readonly location: LocationService,
  ) {}

  /**
   * @param city    A chosen city. Wins over `country`, as it does on every other page.
   * @param country The visitor's country (ISO code) when no city is chosen.
   */
  async sections(city?: string, country?: string): Promise<SectionFeed> {
    // Raw city in the key (not lowercased) so a strategy that matches city
    // case-sensitively can never be served another casing's result. The country only takes
    // part when there is no city, because only then does it change the answer.
    const key = `disc:sections:${city ?? 'all'}:${city ? '-' : (country?.toUpperCase() ?? 'all')}`;
    return this.cache.getOrSet(key, SECTIONS_CACHE_TTL_SECONDS, () => this.compose(city, country));
  }

  private async compose(city?: string, country?: string): Promise<SectionFeed> {
    if (!city) {
      // Scoped to the country, or to nothing when we could not place the visitor at all —
      // the one case where "everywhere" is the honest answer.
      return { sections: await this.composeFor({ country }), appliedCity: null };
    }

    /*
      Resolve the city against what is actually on sale.

      Two reasons. Strategies must get the CANONICAL spelling: "MUMBAI" from a deep link and
      "Mumbai" from the picker are the same place, and a case-sensitive strategy would find
      nothing for one of them. And a city with nothing on sale has nothing to compose — not
      every strategy filters by place, so composing anyway would produce a lonely shelf of
      something unrelated with nothing to say why the rest of the page is missing (caught
      against a real database, where Pune returned exactly one section).
    */
    const sellable = await this.location.cities();
    const match = sellable.find((c) => c.city.toLowerCase() === city.toLowerCase());
    if (!match) return { sections: [], appliedCity: city };
    return { sections: await this.composeFor({ city: match.city }), appliedCity: match.city };
  }

  private async composeFor(place: {
    city?: string;
    country?: string;
  }): Promise<DiscoverySection[]> {
    const ctx: DiscoveryContext = { ...place, now: new Date() };
    const composed = await Promise.all(this.strategies.map((s) => s.discover(ctx)));
    return composed.filter((section) => section.items.length > 0);
  }
}
