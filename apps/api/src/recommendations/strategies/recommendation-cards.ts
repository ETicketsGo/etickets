import { EventStatus, ExperienceType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import type { FeeMode } from '@eticketsgo/shared-types';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AdvertisedPriceService } from '../../pricing/advertised-price.service';
import type {
  PublicEventCardLike,
  RecommendationContext,
} from './recommendation-strategy.interface';

/**
 * Shared read helpers for recommendation strategies. All reads are scoped to
 * PUBLISHED, EVENT-type experiences (movies surface via their own feeds) and
 * map to the exact `PublicEventsService.list` card shape so the output is
 * interchangeable across strategies. Read-only; no writes, no raw SQL.
 */

/** The published-events-only base filter every candidate query starts from. */
const PUBLISHED_EVENTS: Prisma.EventWhereInput = {
  status: EventStatus.PUBLISHED,
  experienceType: ExperienceType.EVENT,
};

/** How many candidates to over-fetch so exclusions never starve the result. */
const CANDIDATE_POOL = 24;

/** Minimal seed-event metadata used to derive content/organizer/venue filters. */
export interface SeedEvent {
  id: string;
  category: string;
  organizationId: string;
  venueId: string;
}

/** Load the seed event's category/organizer/venue, or null if it doesn't exist. */
export async function loadSeedEvent(
  prisma: PrismaService,
  eventId: string,
): Promise<SeedEvent | null> {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, category: true, organizationId: true, venueId: true },
  });
}

/**
 * Fetch published EVENT cards matching `where`, mapped to the public card shape
 * (identical to `PublicEventsService.list`). Ordered newest-published first for
 * a deterministic baseline that a ranker/port can later reorder.
 */
/**
 * Candidate cards for a recommendation strategy.
 *
 * `advertised` is threaded in rather than omitted because a recommendation carousel sits
 * beside a browse listing on the same page. If one applied the all-in display rule and the
 * other did not, the platform would show two different prices for the same ticket — which
 * is worse than showing the bare price everywhere, and is the exact failure the all-in
 * rules exist to address. It is optional only so the pure-function tests can call this
 * without constructing a Nest provider; every real caller passes it.
 */
export async function fetchEventCards(
  prisma: PrismaService,
  where: Prisma.EventWhereInput,
  take: number = CANDIDATE_POOL,
  advertised?: AdvertisedPriceService,
): Promise<PublicEventCardLike[]> {
  const events = await prisma.event.findMany({
    where: { ...PUBLISHED_EVENTS, ...where },
    take,
    orderBy: { publishedAt: 'desc' },
    include: {
      venue: { select: { name: true, city: true, country: true } },
      organization: { select: { name: true } },
      sessions: {
        orderBy: { startsAt: 'asc' },
        take: 1,
        include: { ticketTypes: { orderBy: { priceMinor: 'asc' }, take: 1 } },
      },
    },
  });
  return Promise.all(
    events.map(async (e) => {
      const currency = e.sessions[0]?.ticketTypes[0]?.currency ?? 'INR';
      const base = e.sessions[0]?.ticketTypes[0]?.priceMinor ?? null;
      return {
        id: e.id,
        title: e.title,
        slug: e.slug,
        category: e.category,
        venue: e.venue,
        organizer: e.organization.name,
        nextSessionAt: e.sessions[0]?.startsAt ?? null,
        fromPriceMinor: advertised
          ? await advertised.forTicket(base, e.feeMode as FeeMode, currency)
          : base,
        currency,
      };
    }),
  );
}

/** The set of event ids a strategy must never return: the seed + explicit excludes. */
export function buildExcludeSet(ctx: RecommendationContext): Set<string> {
  const set = new Set(ctx.excludeEventIds ?? []);
  if (ctx.seedEventId) set.add(ctx.seedEventId);
  return set;
}

/** Drop excluded ids (preserving order) and cap to `limit`. Never mutates input. */
export function excludeAndCap(
  cards: PublicEventCardLike[],
  exclude: Set<string>,
  limit: number,
): PublicEventCardLike[] {
  const out: PublicEventCardLike[] = [];
  for (const card of cards) {
    if (exclude.has(card.id)) continue;
    out.push(card);
    if (out.length >= limit) break;
  }
  return out;
}
