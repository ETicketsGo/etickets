/**
 * Discovery strategy seam.
 *
 * A DiscoveryStrategy produces ONE homepage/explore section (trending events,
 * new movie releases, organizer spotlight, …). The composer
 * (`DiscoverySectionsService`) depends only on this contract, never on a
 * concrete strategy, so new sections are added by registering another strategy
 * — no composer change required. This mirrors the InventoryStrategy seam.
 *
 * All strategies are READ-ONLY and additive: they reuse the existing public
 * services / Prisma reads and never touch booking, payment or inventory writes.
 *
 * NOTE: the client-side-only concepts — RecentlyViewed, ContinueExploring and
 * Collections — are deliberately NOT server strategies. They are personal to a
 * device and are rendered on the client from the `etg_recent` localStorage
 * store (see apps/customer-web/lib/recent.ts and the /explore page). Keeping
 * them off the server avoids per-user state here and keeps this seam stateless.
 */

/** The section kinds the client knows how to render (card grid or list). */
export type DiscoverySectionKind = 'events' | 'movies' | 'organizers' | 'venues';

/** A single composed discovery section. `items` shape depends on `kind`. */
export interface DiscoverySection {
  key: string;
  title: string;
  kind: DiscoverySectionKind;
  items: unknown[];
}

/** Everything a strategy needs to build its section. */
export interface DiscoveryContext {
  /** Optional city to localise results (city-based; see NearbyStrategy). */
  city?: string;
  /** "Now" is injected so strategies are deterministic and testable. */
  now: Date;
}

/** The pluggable contract every discovery section implements. */
export interface DiscoveryStrategy {
  /** Stable identifier, also used as the section key. */
  readonly key: string;
  /** Build this strategy's section for the given context. */
  discover(ctx: DiscoveryContext): Promise<DiscoverySection>;
}

/** DI token for the ordered array of registered strategies. */
export const DISCOVERY_STRATEGIES = 'discovery.strategies';
