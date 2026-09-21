import type { Prisma } from '@prisma/client';
import { countryAliases } from '../../common/country';
import type { DiscoveryContext } from './discovery-strategy.interface';

/**
 * The venue filter for the place the visitor is browsing — one definition for every section.
 *
 * ── WHY ONE FUNCTION ───────────────────────────────────────────────────────────────
 * Explore was the page the country rule never reached. Each section built its own filter
 * from `ctx.city` alone, so a visitor scoped to a COUNTRY with no city chosen — which is
 * every visitor until they pick one — got sections filtered by nothing. The owner opened
 * Explore from the United States and was shown Hyderabad, Mumbai, Boise and Meridian on one
 * screen. Browse and Movies had been fixed; this page had its own copy of the rule and it
 * was the old one.
 *
 * City wins over country, as it does everywhere else: a city already implies its country,
 * and ANDing both would turn one mistyped country into an empty page for a city somebody
 * explicitly chose. Countries are matched through the alias table, because the visitor's
 * scope is an ISO code ("IN") and a venue carries whatever its organizer typed ("India").
 */
export function venueInScope(
  ctx: Pick<DiscoveryContext, 'city' | 'country'>,
): Prisma.VenueWhereInput {
  if (ctx.city) return { city: { equals: ctx.city, mode: 'insensitive' } };
  if (ctx.country) return { country: { in: countryAliases(ctx.country), mode: 'insensitive' } };
  return {};
}
