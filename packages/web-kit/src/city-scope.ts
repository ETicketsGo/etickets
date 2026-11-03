import { marketFor } from '@eticketsgo/shared-types';

/*
  The pure half of the city preference: what a stored choice means and what to ask the API for.

  It lives apart from `city.tsx` (a client module) so the SERVER can run exactly the same rules.
  A storefront page that renders its lists on the server has to scope them the way the browser
  will, or the first paint shows one place and the browser swaps in another a moment later -
  which is what visitors saw: the whole catalogue, or "Coming up", replaced by "Coming up in
  India" once the browser had asked where they were.
*/

/**
 * Where a chosen city is: its state and country.
 *
 * A city name alone is not a place - there is a Springfield in Illinois and one in Missouri,
 * and a Hyderabad in India and one in Pakistan. A city chosen from "use my location" or from
 * the search carries where it is, and that travels with it to every list it filters.
 */
export interface CityPlace {
  region: string | null;
  country: string | null;
}

/** Stored when the person deliberately chose everywhere, so we stop suggesting at them. */
export const ALL_CITIES = '__all__';

/** The device's stored city, in localStorage (the source of truth on the device). */
export const CITY_STORAGE_KEY = 'etg.city';

/**
 * The same stored value, mirrored into a cookie so a server render can scope its lists.
 * Same encoding as the localStorage value, URI-encoded. A preference, never a credential.
 */
export const CITY_COOKIE = 'etg_city';

/** The resolved market (scope country), mirrored for the server. See `rememberMarketCountry`. */
export const MARKET_COOKIE = 'etg_market';

/**
 * A two-letter country code, or null. Venue data spells countries out ("India"); scope uses codes.
 * Read through the market table so a city picked from the list - which names its country - keeps
 * its own country as the scope, instead of silently falling back to a guess.
 */
export function isoCountry(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return marketFor(v)?.code ?? null;
}

/** A stored city choice: a city with its place, or `ALL_CITIES`. */
export interface StoredCity {
  city: string;
  place: CityPlace;
}

/**
 * Reads a stored city value - the localStorage string, or the cookie that mirrors it.
 * Older visits stored the bare name; it is still honoured, with no place attached.
 */
export function parseStoredCity(raw: string | null | undefined): StoredCity | null {
  if (!raw) return null;
  if (!raw.startsWith('{')) return { city: raw, place: { region: null, country: null } };
  try {
    const parsed = JSON.parse(raw) as { city?: unknown; region?: unknown; country?: unknown };
    if (typeof parsed.city !== 'string' || !parsed.city) return null;
    return {
      city: parsed.city,
      place: {
        region: typeof parsed.region === 'string' ? parsed.region : null,
        country: typeof parsed.country === 'string' ? parsed.country : null,
      },
    };
  } catch {
    return null;
  }
}

/** The stored string for a choice; the inverse of `parseStoredCity`. */
export function serializeStoredCity(city: string, place?: CityPlace | null): string {
  if (city === ALL_CITIES) return city;
  return JSON.stringify({ city, region: place?.region ?? null, country: place?.country ?? null });
}

/**
 * Where the preference STARTS, before the browser has asked the API anything.
 *
 * The server builds it from the cookies above, and the browser's provider starts from the same
 * value, so the server render and the first client render agree (no hydration mismatch) and both
 * already show the visitor's place.
 *
 * `ready` says whether that start is good enough to fetch with. It is when the device already
 * knows the scope: a market resolved on an earlier visit, or a city carrying its own country.
 * It is not on a first visit, when nothing says where somebody is; lists then wait for the
 * browser's one location answer instead of showing every country and swapping.
 */
export interface CitySeed {
  /** The stored city, `ALL_CITIES`, or null when nothing was chosen. */
  city: string | null;
  place: CityPlace | null;
  chosen: boolean;
  /** The scope country (ISO), or null when unknown. */
  country: string | null;
  ready: boolean;
}

export const EMPTY_CITY_SEED: CitySeed = {
  city: null,
  place: null,
  chosen: false,
  country: null,
  ready: false,
};

export function citySeedFrom(input: {
  /** The stored city (cookie or localStorage), raw. */
  stored: string | null | undefined;
  /** The `etg_market` value, raw. */
  market: string | null | undefined;
}): CitySeed {
  const stored = parseStoredCity(input.stored ? safeDecode(input.stored) : null);
  const market = isoCountry(input.market ? safeDecode(input.market) : null);
  const own = stored && stored.city !== ALL_CITIES ? isoCountry(stored.place.country) : null;
  // The same ranking the provider applies when the location answer arrives: a chosen city's own
  // country beats any guess.
  const country = own ?? market;
  return {
    city: stored?.city ?? null,
    place: stored && stored.city !== ALL_CITIES ? stored.place : null,
    chosen: Boolean(stored),
    country,
    ready: country !== null,
  };
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** The parts of the preference the scope is computed from. */
export interface ScopeInput {
  city: string | null;
  place: CityPlace | null;
  country: string | null;
}

/**
 * What the storefront should ask the API for, given where the customer is.
 *
 * One place, because the answer has to be identical on the home page, on Browse and on
 * Movies — and it was not: the home page ignored the preference entirely, so choosing
 * Bengaluru in the header changed Browse and left the homepage showing Mumbai. Three
 * pages each deciding this for themselves is three chances to disagree. And now the server
 * too: it renders the first paint with this same function.
 */
export function cityScope(preference: ScopeInput): {
  city?: string;
  country?: string;
  cityCountry?: string;
  region?: string;
} {
  if (preference.city) {
    /*
      The city's OWN country and state travel with it, so Springfield, Illinois and
      Springfield, Missouri are two places. Deliberately not `country`: that is the visitor's
      scope, which a hand-picked city overrides, and the API ignores it when a city is given.
    */
    const place = preference.place;
    return {
      city: preference.city,
      ...(place?.country ? { cityCountry: place.country } : {}),
      ...(place?.region ? { region: place.region } : {}),
    };
  }
  if (preference.country) return { country: preference.country };
  return {};
}

/**
 * The place the customer SELECTED, as the grouping functions want it.
 *
 * The chosen city and that city's own country - not the visitor's guessed scope, which a
 * hand-picked city overrides. With no city, the country scope alone.
 */
export function selectedPlace(preference: ScopeInput): {
  city: string | null;
  country: string | null;
} {
  if (preference.city) {
    return { city: preference.city, country: preference.place?.country ?? preference.country };
  }
  return { city: null, country: preference.country };
}

/** The preference as the pages read it, from a seed: `ALL_CITIES` reads as no city. */
export function scopeInputFromSeed(seed: CitySeed): ScopeInput {
  const city = seed.city === ALL_CITIES ? null : seed.city;
  return { city, place: city ? seed.place : null, country: seed.country };
}
