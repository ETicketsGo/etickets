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

const hasPhoto = (e: Listing) => Boolean(e.imagePath || e.imageVariants);

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

/**
 * Whether a formatted price needs its ISO code beside it to be unambiguous.
 *
 * "$45.00" and "Rs 699" (written with the rupee sign) do: next to each other they could be
 * one currency. "CA$32.00" and the French "45,00 $ US" already name theirs, and adding the code
 * again ("45,00 $ US USD") reads as a mistake. Any Latin letter in the amount means the
 * formatter has already said which currency it is.
 */
export function needsCurrencyCode(formatted: string): boolean {
  return !/[A-Za-z]/.test(formatted);
}
