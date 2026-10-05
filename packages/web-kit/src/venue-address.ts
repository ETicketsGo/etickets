/**
 * One address line for a venue, without saying the city twice.
 *
 * ── THE DEFECT THIS FIXES ──────────────────────────────────────────────────────────
 * A venue's city, state and country are separate columns, and `address` is one optional
 * free-text box labelled "Address". An organizer given a bare Address box types the whole
 * address into it, because that is what the word means - and the event page then appended the
 * city and country it already had, so a real listing read:
 *
 *     Worli, Mumbai, MH, Mumbai, India
 *
 * Two halves are needed and only one of them is the label. Telling organizers the box is for
 * the street does not repair the rows already typed, and venues are entered once and looked at
 * for years. So the composition tolerates it: a part of the address that IS the city, the state
 * or the country is not printed again.
 *
 * ── WHY WHOLE PARTS, AND NEVER A SUBSTRING ─────────────────────────────────────────
 * Matching is on a complete comma-separated part, case- and space-insensitive. A substring
 * rule would eat real street names - "Mumbai Road" in Pune, "India Gate" in Delhi - and
 * removing a word from somebody's address is a worse failure than printing one twice, because
 * the reader cannot tell it happened.
 */
export interface VenueAddressParts {
  address?: string | null;
  city?: string | null;
  /** State or province. `region` on the venue. */
  region?: string | null;
  country?: string | null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The address as one line: the street part, then city, state and country, each said once.
 *
 * Returns an empty string when there is nothing to say, so a caller can skip the element
 * rather than render an empty one with its padding and separators.
 */
export function venueAddressLine(venue: VenueAddressParts): string {
  const tail = [venue.city, venue.region, venue.country]
    .map((v) => (v ?? '').trim())
    .filter(Boolean);

  const alreadySaid = new Set(tail.map(normalise));

  const street = (venue.address ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    // Drop any part that is one of the fields we are about to print anyway.
    .filter((part) => !alreadySaid.has(normalise(part)));

  /*
    The tail is de-duplicated against itself too. A venue whose city and state are both
    recorded as "Delhi" is ordinary in India, and "Delhi, Delhi, India" reads like a mistake
    in our software rather than a fact about the place.
  */
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of [...street, ...tail]) {
    const key = normalise(part);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join(', ');
}

/**
 * The same place, phrased for a maps search.
 *
 * The name leads because that is what a mapping service matches best, and the duplicate
 * removal matters here too: a query that repeats the city scores worse, not better.
 */
export function venueMapQuery(venue: VenueAddressParts & { name?: string | null }): string {
  const line = venueAddressLine(venue);
  const name = (venue.name ?? '').trim();
  if (!name) return line;
  // A venue whose name is already the first part of the address is not named twice.
  return normalise(line).startsWith(normalise(name))
    ? line
    : [name, line].filter(Boolean).join(', ');
}
