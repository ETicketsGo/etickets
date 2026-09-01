import { Injectable } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { countryMatches } from '../common/country';

/**
 * Where the person browsing is, and which cities we can actually sell them a ticket in.
 *
 * ── WHY THIS IS NOT JUST "CALL A GEOLOCATION API" ──────────────────────────────────
 * Discovery has been able to filter by city for a long time; nothing ever chose one. The
 * hard part was never the lookup, it is deciding what to do with a guess that might be
 * wrong — and every source of location is wrong in a different way:
 *
 *   - The edge header (Cloudflare's `cf-ipcountry` and friends) is free and silent, and is
 *     wrong for anyone on a VPN, a corporate egress, or a mobile carrier that routes
 *     through another state.
 *   - The browser Geolocation API is accurate, and needs a permission prompt that a large
 *     share of people decline — and firing one unprompted on a homepage is hostile.
 *   - The device region (`expo-localization`) needs no permission and tells you where the
 *     phone was *configured*, not where it is.
 *
 * So this service never pretends to know. It returns a guess WITH ITS SOURCE, and the
 * client decides whether that is good enough to apply silently or worth confirming. A
 * coordinate fix is applied; a country guessed from an IP header is offered.
 *
 * ── THE FAILURE THIS EXISTS TO PREVENT ─────────────────────────────────────────────
 * A city filter that silently matches nothing is worse than no filter at all: the customer
 * sees an empty homepage and concludes the platform has nothing on sale anywhere. So a
 * resolved city is only ever returned if it is a city we actually sell in — see
 * `resolve()`, which checks its own answer before handing it back.
 */

/** How the answer was arrived at. The client shows different UI for each. */
export type LocationSource =
  | 'coordinates' // browser/device GPS, offered by the person. Trust it.
  | 'network' // edge header from the IP. A default worth confirming.
  | 'device-region' // the device's configured country. Country only, and only a hint.
  | 'none'; // we genuinely do not know, and say so.

export interface SellableCity {
  city: string;
  country: string;
  /** How many published, still-upcoming events sit in this city. Never a guess. */
  eventCount: number;
}

/** How the caller wants the city list narrowed. All optional; omitting all means "everything". */
export interface CitySearch {
  /** Prefix of the city name, matched against each word of it. */
  q?: string;
  /** Restrict to one country, in either spelling. */
  country?: string;
  /** Most-inventory-first cap. The picker asks for a handful; nothing else needs a cap. */
  limit?: number;
}

export interface ResolvedLocation {
  country: string | null;
  city: string | null;
  source: LocationSource;
  /**
   * Whether the client should ask before applying this.
   *
   * True only for a coordinate fix, where the person has already actively consented and the
   * answer is accurate. Everything else is a suggestion.
   */
  confident: boolean;
  /**
   * The country it is SAFE to filter by, or null.
   *
   * ── WHY THIS IS NOT JUST `country` ─────────────────────────────────────────────
   * `country` above is the raw guess and may be anywhere on earth. This one is the guess
   * only when we have something on sale there, and null otherwise.
   *
   * The distinction is the whole feature. Scoping discovery to a country the platform does
   * not operate in shows the visitor an empty storefront, and an empty storefront is
   * indistinguishable from a dead company — the customer does not think "my locale is
   * wrong", they think "there is nothing here" and leave. A guess is allowed to be wrong;
   * it is not allowed to be wrong and invisible.
   *
   * This is the same rule `resolve` already applied to a guessed CITY, which was only ever
   * returned if we could sell there. Scoping by country arrived later and did not inherit
   * it — and the e2e suite went red the first time it ran under a US locale against Indian
   * inventory, which is precisely the scenario.
   */
  scopeCountry: string | null;

  /**
   * A few cities worth offering immediately, most inventory first — NOT the whole list.
   *
   * Deliberately capped and deliberately not called `cities`. It used to be every sellable
   * city, which was fine at six and becomes a payload nobody reads at six hundred; worse,
   * a client holding "all the cities" builds a menu out of them, and a menu of six hundred
   * cities is not a menu. Anything beyond these comes from `GET /public/location/cities?q=`,
   * which is a search.
   */
  topCities: SellableCity[];
}

/**
 * The edge headers we trust, in the order we trust them.
 *
 * Deliberately a short, named list rather than anything clever. These are set by the proxy
 * in front of the API and cannot be forged from outside it — but only if the proxy actually
 * sets them, which is why an unknown deployment resolves to 'none' rather than to whatever
 * a client chose to send.
 */
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-appengine-country'] as const;
const CITY_HEADERS = ['cf-ipcity', 'x-vercel-ip-city'] as const;

const CITIES_CACHE_TTL_SECONDS = 300;

/** How many cities `resolve` offers up front. Enough to choose from, few enough to read. */
const RESOLVE_CITY_COUNT = 8;

/** Kilometres between two points. Good enough to pick the nearest of a few dozen cities. */
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * How far away a venue can be and still count as "your city".
 *
 * 120km is generous on purpose. Someone in Thane should be shown Mumbai, and someone an
 * hour outside a metro should be offered it rather than an empty page. The client always
 * names the city it applied, so a wrong guess is visible and one click from being fixed.
 */
const NEAREST_CITY_RADIUS_KM = 120;

@Injectable()
export class LocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Cities with something on sale, most inventory first — searched, not enumerated.
   *
   * Derived from live inventory rather than from a static list, so a city cannot appear
   * until the day it has something to sell, and drops out again when it does not. A
   * hardcoded list of "launch cities" would be out of date the first time an organizer in a
   * new city published.
   *
   * The search exists because the picker cannot show them all. At six cities a menu is
   * fine; the platform is being built for hundreds, and the honest answer at that size is a
   * box you type into, which means the filtering has to happen here rather than in a
   * component holding the whole world in memory.
   */
  async cities(query?: CitySearch): Promise<SellableCity[]> {
    const all = await this.allCities();
    const q = query?.q?.trim().toLowerCase();
    const limit = query?.limit ?? all.length;

    const matches = all.filter((c) => {
      if (query?.country && !countryMatches(c.country, query.country)) return false;
      if (!q) return true;
      /*
        Prefix, not substring.

        "san" should offer San Francisco, not Rosande. Substring matching feels cleverer
        and is worse at the only job here: somebody typing the start of the name they
        already have in mind. The exception is a multi-word city — "york" has to find New
        York — so every word of the name is a candidate prefix.
      */
      return c.city
        .toLowerCase()
        .split(/[\s-]+/)
        .some((word) => word.startsWith(q));
    });
    return matches.slice(0, limit);
  }

  /** Every sellable city, cached. The filtered view above is derived from this one list. */
  private async allCities(): Promise<SellableCity[]> {
    return this.cache.getOrSet('location:cities', CITIES_CACHE_TTL_SECONDS, async () => {
      const live = {
        status: EventStatus.PUBLISHED,
        sessions: { some: { startsAt: { gte: new Date() } } },
      };
      const venues = await this.prisma.venue.findMany({
        where: { events: { some: live } },
        select: {
          city: true,
          country: true,
          _count: { select: { events: { where: live } } },
        },
      });

      // Two venues in the same city are one entry. Folded case-insensitively, but the first
      // spelling seen is kept for display — "Bengaluru" should not become "bengaluru" in the
      // picker just because that is how it normalises.
      const byCity = new Map<string, SellableCity>();
      for (const v of venues) {
        const key = `${v.country.toLowerCase()}|${v.city.toLowerCase()}`;
        const existing = byCity.get(key);
        if (existing) existing.eventCount += v._count.events;
        else byCity.set(key, { city: v.city, country: v.country, eventCount: v._count.events });
      }
      return [...byCity.values()].sort(
        (a, b) => b.eventCount - a.eventCount || a.city.localeCompare(b.city),
      );
    });
  }

  /**
   * Best guess at where this request is from, with the reason attached.
   *
   * Order is by accuracy, not convenience: real coordinates beat the network, the network
   * beats the device's configured region, and no answer at all beats a made-up one.
   */
  async resolve(input: {
    headers: Record<string, string | string[] | undefined>;
    latitude?: number;
    longitude?: number;
    deviceRegion?: string;
  }): Promise<ResolvedLocation> {
    const cities = await this.cities();

    const inCountry = (country: string | null): SellableCity[] =>
      country ? cities.filter((c) => countryMatches(c.country, country)) : [];

    /** The handful to offer up front, preferring the country we think they are in. */
    const offer = (country: string | null): SellableCity[] => {
      const local = inCountry(country);
      // Falls back to the busiest cities anywhere rather than to nothing: a visitor in a
      // country we do not sell in yet should still see somewhere they could go.
      return (local.length ? local : cities).slice(0, RESOLVE_CITY_COUNT);
    };

    /** A country worth filtering by is a country we have something to sell in. */
    const scope = (country: string | null): string | null =>
      inCountry(country).length ? country : null;

    // 1. Coordinates the person actively offered. The only source good enough to apply
    //    without asking.
    if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
      const nearest = await this.nearestSellableCity(input.latitude, input.longitude, cities);
      if (nearest) {
        return {
          country: nearest.country,
          city: nearest.city,
          source: 'coordinates',
          confident: true,
          scopeCountry: scope(nearest.country),
          topCities: offer(nearest.country),
        };
      }
      /*
        Coordinates that match nothing fall through rather than returning the nearest city
        regardless of distance. Someone in a country we do not operate in is better served
        by "pick a city" than by being told their nearest event is four thousand kilometres
        away.
      */
    }

    // 2. The edge header. Silent, free, and wrong often enough that it is only ever a
    //    suggestion the client should confirm.
    const country = this.firstHeader(input.headers, COUNTRY_HEADERS)?.toUpperCase() ?? null;
    const headerCity = this.firstHeader(input.headers, CITY_HEADERS);
    if (headerCity) {
      const match = cities.find((c) => c.city.toLowerCase() === headerCity.toLowerCase());
      // Only returned if we can actually sell there. An unmatched city name would filter
      // the homepage down to nothing.
      if (match) {
        return {
          country: match.country,
          city: match.city,
          source: 'network',
          confident: false,
          scopeCountry: scope(match.country),
          topCities: offer(match.country),
        };
      }
    }
    if (country) {
      const inCountry = cities.filter((c) => countryMatches(c.country, country));
      return {
        country,
        // Exactly one city in the country means there is nothing to choose between.
        city: inCountry.length === 1 ? inCountry[0].city : null,
        source: 'network',
        confident: false,
        scopeCountry: scope(country),
        topCities: offer(country),
      };
    }

    // 3. The device's configured region. Country only, and never a city.
    if (input.deviceRegion) {
      return {
        country: input.deviceRegion.toUpperCase(),
        city: null,
        source: 'device-region',
        confident: false,
        scopeCountry: scope(input.deviceRegion.toUpperCase()),
        topCities: offer(input.deviceRegion.toUpperCase()),
      };
    }

    // 4. Nothing. Said plainly, so the client asks instead of guessing.
    return {
      country: null,
      city: null,
      source: 'none',
      confident: false,
      scopeCountry: null,
      topCities: offer(null),
    };
  }

  /** Nearest city with inventory, using cinema coordinates — the only geo the platform stores. */
  private async nearestSellableCity(
    latitude: number,
    longitude: number,
    cities: SellableCity[],
  ): Promise<SellableCity | null> {
    const points = await this.prisma.cinema.findMany({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: { city: true, latitude: true, longitude: true },
    });

    let best: { city: SellableCity; km: number } | null = null;
    for (const p of points) {
      const sellable = cities.find((c) => c.city.toLowerCase() === p.city.toLowerCase());
      if (!sellable) continue; // a cinema with nothing on sale is not an answer
      const km = distanceKm(latitude, longitude, p.latitude!, p.longitude!);
      if (km <= NEAREST_CITY_RADIUS_KM && (!best || km < best.km)) best = { city: sellable, km };
    }
    return best?.city ?? null;
  }

  private firstHeader(
    headers: Record<string, string | string[] | undefined>,
    names: readonly string[],
  ): string | null {
    for (const name of names) {
      const raw = headers[name] ?? headers[name.toLowerCase()];
      const value = Array.isArray(raw) ? raw[0] : raw;
      const trimmed = value?.trim();
      // Cloudflare sends "XX" for anonymising proxies and "T1" for Tor. Both mean "we could
      // not tell", and treating either as a country would produce a filter matching nothing.
      if (trimmed && trimmed !== 'XX' && trimmed !== 'T1') return trimmed;
    }
    return null;
  }
}
