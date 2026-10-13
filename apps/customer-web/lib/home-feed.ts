import { countryMatches } from '@eticketsgo/shared-types';

/*
  The home page's ordering and labelling rules, kept pure so they can be tested without a page.
  None of them changes WHAT is listed - the API decides that - only which listing leads.
*/

type Listing = {
  /** Outside production: DEMO sample content or TEST data. Null/absent in production. */
  contentLabel?: 'DEMO' | 'TEST' | null;
  imagePath?: string | null;
  imageVariants?: unknown;
  venue: { country: string };
};

/** Whether the organizer uploaded a picture for this listing. */
export const hasPhoto = (e: Listing) => Boolean(e.imagePath || e.imageVariants);

/** Curated sample content ahead of test data. Always equal in production, where nothing is labelled. */
const isDemo = (e: { contentLabel?: 'DEMO' | 'TEST' | null }) => Number(e.contentLabel === 'DEMO');

/**
 * Sample (DEMO) content first outside production, then listings with a photo, otherwise the
 * API's order (Array.prototype.sort is stable). TEST data is ranked after DEMO, never hidden.
 * The hero is picked from this order, so it prefers a DEMO event over a TEST one.
 */
export function photosFirst<T extends Listing>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => isDemo(b) - isDemo(a) || Number(hasPhoto(b)) - Number(hasPhoto(a)),
  );
}

/** Sample films first, then films with a poster, otherwise the API's order. */
export function postersFirst<
  T extends { posterUrl: string | null; contentLabel?: 'DEMO' | 'TEST' | null },
>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => isDemo(b) - isDemo(a) || Number(Boolean(b.posterUrl)) - Number(Boolean(a.posterUrl)),
  );
}

/**
 * Events elsewhere, nearest first in the plainest sense: the visitor's own country ahead of
 * the rest of the world (somebody in Dallas sees New York before Bengaluru), then photos first,
 * then the API's order. Countries compare through the alias table, because a venue says "India"
 * where the scope says "IN".
 */
export function nearestFirst<T extends Listing>(
  list: readonly T[],
  homeCountry: string | null,
): T[] {
  const near = (e: T) => (homeCountry && countryMatches(e.venue.country, homeCountry) ? 1 : 0);
  return photosFirst(list).sort((a, b) => near(b) - near(a));
}

/** One titled group of events elsewhere: one currency, never mixed. */
export interface CurrencyGroup<T> {
  currency: string;
  /** The venue country of the group's first event, to title it ("In Canada"). */
  country: string;
  items: T[];
}

/**
 * Events outside the visitor's city, in groups of ONE currency each.
 *
 * A rail that put "Rs 1,499" beside "$45.00" beside "CA$32.00" asked the reader to notice
 * three currencies in one glance, and a buyer who does not is charged in one they did not
 * expect. So each group is one currency, titled with where it is and which currency it
 * prices in. The visitor's own currency comes first (an India visitor sees the rest of India
 * before New York); then the groups in the order their nearest event appears.
 */
export function outsideGroups<T extends Listing & { currency: string }>(
  list: readonly T[],
  home: { currency: string | null; country: string | null },
  { perGroup = 4, maxGroups = 3 }: { perGroup?: number; maxGroups?: number } = {},
): CurrencyGroup<T>[] {
  const groups = new Map<string, CurrencyGroup<T>>();
  for (const e of nearestFirst(list, home.country)) {
    const g = groups.get(e.currency);
    if (g) g.items.push(e);
    else groups.set(e.currency, { currency: e.currency, country: e.venue.country, items: [e] });
  }
  return [...groups.values()]
    .sort((a, b) => Number(b.currency === home.currency) - Number(a.currency === home.currency))
    .slice(0, maxGroups)
    .map((g) => ({ ...g, items: g.items.slice(0, perGroup) }));
}

/** Whether a listing can be bought right now, from the public event payload. */
export type Buyability = 'BUYABLE' | 'SOLD_OUT' | 'NOT_YET' | 'CLOSED';

type SaleSession = {
  startsAt: string;
  status: string;
  ticketTypes: { available: number; saleState?: 'ON_SALE' | 'NOT_YET' | 'CLOSED' }[];
};

/**
 * Read from `/public/events/:slug`, which carries each ticket type's `available` count and its
 * sales window (`saleState`). The listing endpoint carries neither, which is why the home
 * page asks for the few events it promotes rather than trusting the card.
 *
 * Only sessions that have not started and are SCHEDULED count (a paused session cannot be
 * bought). An older API without `saleState` is treated as on sale, which is what it meant.
 */
export function buyability(event: { sessions: SaleSession[] }, now: Date = new Date()): Buyability {
  const types = event.sessions
    .filter((s) => s.status === 'SCHEDULED' && new Date(s.startsAt) > now)
    .flatMap((s) => s.ticketTypes);
  const onSale = types.filter((t) => (t.saleState ?? 'ON_SALE') === 'ON_SALE');
  if (onSale.some((t) => t.available > 0)) return 'BUYABLE';
  if (onSale.length > 0) return 'SOLD_OUT';
  if (types.some((t) => t.saleState === 'NOT_YET')) return 'NOT_YET';
  return 'CLOSED';
}

/** How many photo listings the hero tries before stepping down to the compact band. */
export const HERO_CANDIDATES = 6;

/**
 * The featured event: the first listing, in the page's order, that has a photo AND can be
 * bought right now. A hero that says "Book tickets" over a sold-out show is a promise the next
 * page breaks (found on review: "Sold Out Sessions" was the Bengaluru hero).
 *
 * `states` holds what is known so far. An undecided candidate ahead of the first buyable one
 * means "wait" (`pending`), so the page never shows a hero it might have to take back.
 * Nothing buyable among the first HERO_CANDIDATES photos: no hero, and the stage steps down.
 */
export function chooseHero<T extends Listing & { slug: string }>(
  list: readonly T[],
  states: ReadonlyMap<string, Buyability | undefined>,
): { hero: T | null; pending: boolean } {
  for (const e of photosFirst(list).filter(hasPhoto).slice(0, HERO_CANDIDATES)) {
    const state = states.get(e.slug);
    if (state === undefined) return { hero: null, pending: true };
    if (state === 'BUYABLE') return { hero: e, pending: false };
  }
  return { hero: null, pending: false };
}

/** The slugs `chooseHero` may need to know about, in the order it will ask. */
export function heroCandidates<T extends Listing & { slug: string }>(list: readonly T[]): string[] {
  return photosFirst(list)
    .filter(hasPhoto)
    .slice(0, HERO_CANDIDATES)
    .map((e) => e.slug);
}

/** What a card shows where the price would be. */
export type PriceSlot = 'price' | 'soldOut' | 'notYet' | 'closed' | 'none';

/**
 * The price only when the event's own payload proves a ticket is on sale. A card whose read
 * has not arrived (or was never made) shows its date and no price: "From Rs 799" over a
 * sold-out show is the misleading price this exists to prevent.
 */
export function priceSlot(state: Buyability | undefined): PriceSlot {
  switch (state) {
    case 'BUYABLE':
      return 'price';
    case 'SOLD_OUT':
      return 'soldOut';
    case 'NOT_YET':
      return 'notYet';
    case 'CLOSED':
      return 'closed';
    default:
      return 'none';
  }
}
