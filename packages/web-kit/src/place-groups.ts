import { countryDisplay } from './country-display';

/*
  How the storefront orders what is on, once it knows the customer's SELECTED city.

  Pure functions, no React and no network: the pages fetch, these decide. They never change WHAT
  is listed, only which group a listing falls in and what order the groups come in:

    1. here           - the selected city
    2. same country   - the rest of that country
    3. elsewhere      - everything else, one titled group per country ("Elsewhere: Canada")

  Inside a group the caller's order is kept (it carries the DEMO-before-TEST ordering the API
  applies), so grouping never reshuffles what the API already ranked.
*/

/** Case, accents and padding differ between the places a city name is typed. */
export function foldCity(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** A country as ISO alpha-2 when it is a known market, else the value as stored (upper-cased). */
export function countryKey(value: string | null | undefined): string | null {
  const shown = countryDisplay(value);
  if (!shown) return null;
  return shown.code ?? shown.name.toUpperCase();
}

/** A country's display name in whichever spelling it arrived. */
export function countryLabelOf(value: string | null | undefined): string {
  return countryDisplay(value)?.name ?? '';
}

export interface CityGroup {
  /** ISO alpha-2, or the stored name for a country that is not a declared market. */
  code: string;
  name: string;
  cities: {
    city: string;
    country: string;
    countryCode?: string;
    eventCount: number;
    region?: string | null;
  }[];
}

/**
 * Cities grouped by country for the picker, one entry per real place.
 *
 * Venues store "India" and "IN" side by side, so a list built from stored text shows Hyderabad
 * twice. The API now answers with one spelling, and this still folds on (country, folded name) so
 * an older API or a cached answer cannot bring the duplicate back; counts of folded rows add up.
 * The visitor's own country leads; the rest follow by how much is on sale there.
 */
export function groupCitiesByCountry<
  C extends { city: string; country: string; countryCode?: string; eventCount: number },
>(
  cities: readonly C[],
  homeCountry?: string | null,
): (Omit<CityGroup, 'cities'> & { cities: C[] })[] {
  const groups = new Map<string, Omit<CityGroup, 'cities'> & { cities: C[] }>();
  const seen = new Map<string, C>();
  for (const c of cities) {
    const code = c.countryCode ?? countryKey(c.country) ?? c.country;
    const key = `${code}|${foldCity(c.city)}`;
    const twin = seen.get(key);
    if (twin) {
      twin.eventCount += c.eventCount;
      continue;
    }
    const copy = { ...c };
    seen.set(key, copy);
    let group = groups.get(code);
    if (!group) {
      group = {
        code,
        name: countryLabelOf(code) || countryLabelOf(c.country) || c.country,
        cities: [],
      };
      groups.set(code, group);
    }
    group.cities.push(copy);
  }
  const home = homeCountry ? countryKey(homeCountry) : null;
  const total = (g: { cities: C[] }) => g.cities.reduce((n, c) => n + c.eventCount, 0);
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.code === home) - Number(a.code === home) ||
      total(b) - total(a) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * The countries discovery works in, in the order a visitor with no home country sees them.
 * Mirrors the API's list (location.service `DISCOVERY_COUNTRIES`), which decides what the
 * picker offers; this decides which countries get an "Elsewhere" group.
 */
export const DISCOVERY_COUNTRIES = ['IN', 'US', 'CA'] as const;

export interface PlaceGroupRequest {
  kind: 'sameCountry' | 'elsewhere';
  /** ISO alpha-2 of the group's country. */
  code: string;
  /** The country's name, for its title. */
  name: string;
  /** Query parameters for the listing, to merge with the page's own search. */
  params: { country: string; excludeCity?: string };
}

/**
 * What to ask the API for, to fill the groups under the selected place.
 *
 * One request PER GROUP rather than one big catalogue read that is sorted afterwards: a busy
 * city (86 of the events on QA are in Hyderabad) fills any fixed page size and the other
 * countries never arrive, so "Elsewhere: Canada" would be missing exactly when it matters.
 *
 * - `sameCountry`: the selected city's country without that city. Only with a city; with a
 *   country alone the page itself IS the country and repeating it below adds nothing.
 * - `elsewhere`: every other discovery country, in `DISCOVERY_COUNTRIES` order.
 * - No place, or a city whose country is unknown: nothing is requested. Naming a country as
 *   "elsewhere" could mean the city's own, and a wrong group is worse than a missing one.
 *
 * The city only means something inside its own country, so Hyderabad (India) never hides
 * anything in another country.
 */
export function placeGroupRequests(place: {
  city?: string | null;
  country?: string | null;
}): PlaceGroupRequest[] {
  const home = countryKey(place.country);
  const city = place.city?.trim();
  // Without a country there is no honest "elsewhere": every market could be the city's own.
  if (!home) return [];

  const requests: PlaceGroupRequest[] = [];
  if (city) {
    requests.push({
      kind: 'sameCountry',
      code: home,
      name: countryLabelOf(home),
      params: { country: home, excludeCity: city },
    });
  }
  for (const code of DISCOVERY_COUNTRIES) {
    if (code === home) continue;
    requests.push({
      kind: 'elsewhere',
      code,
      name: countryLabelOf(code),
      params: { country: code },
    });
  }
  return requests;
}
