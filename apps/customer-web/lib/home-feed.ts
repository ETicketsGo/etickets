import { countryMatches } from '@eticketsgo/shared-types';

/*
  The home page's ordering and labelling rules, kept pure so they can be tested without a page.
  None of them changes WHAT is listed - the API decides that - only which listing leads.
*/

type Listing = {
  imagePath?: string | null;
  imageVariants?: unknown;
  venue: { country: string };
};

/** Whether the organizer uploaded a picture for this listing. */
export const hasPhoto = (e: Listing) => Boolean(e.imagePath || e.imageVariants);

/** Listings with a photo first, otherwise the API's order (Array.prototype.sort is stable). */
export function photosFirst<T extends Listing>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(hasPhoto(b)) - Number(hasPhoto(a)));
}

/** Films with a poster first, otherwise the API's order. */
export function postersFirst<T extends { posterUrl: string | null }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(Boolean(b.posterUrl)) - Number(Boolean(a.posterUrl)));
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
