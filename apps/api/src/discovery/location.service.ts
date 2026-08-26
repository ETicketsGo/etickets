import { Injectable } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

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
  /** Cities we can sell in, so the client can offer a change without a second call. */
  cities: SellableCity[];
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
   * Cities with something actually on sale, most inventory first.
   *
   * Derived from live inventory rather than from a static list, so a city cannot appear in
   * the picker until the day it has something to sell — and drops out again when it does
   * not. A hardcoded list of "launch cities" would be out of date the first time an
   * organizer in a new city published.
   */
  async cities(): Promise<SellableCity[]> {
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
          cities,
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
          cities,
        };
      }
    }
    if (country) {
      const inCountry = cities.filter((c) => this.countryMatches(c.country, country));
      return {
        country,
        // Exactly one city in the country means there is nothing to choose between.
        city: inCountry.length === 1 ? inCountry[0].city : null,
        source: 'network',
        confident: false,
        cities,
      };
    }

    // 3. The device's configured region. Country only, and never a city.
    if (input.deviceRegion) {
      return {
        country: input.deviceRegion.toUpperCase(),
        city: null,
        source: 'device-region',
        confident: false,
        cities,
      };
    }

    // 4. Nothing. Said plainly, so the client asks instead of guessing.
    return { country: null, city: null, source: 'none', confident: false, cities };
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

  /**
   * Whether a stored country name is the country an edge header named.
   *
   * Headers carry ISO alpha-2 ("IN"); venues store display names ("India"). Rather than ship
   * a 250-row country table for one comparison, this handles the launch markets by name and
   * otherwise compares directly, which is correct for any venue already storing a code. An
   * unmatched pair only means the country hint finds nothing — the picker still lists every
   * city, so nobody is stuck.
   */
  private countryMatches(stored: string, alpha2: string): boolean {
    const s = stored.trim().toLowerCase();
    const known: Record<string, string[]> = {
      IN: ['india', 'in'],
      US: ['united states', 'united states of america', 'usa', 'us'],
      CA: ['canada', 'ca'],
    };
    return (known[alpha2] ?? [alpha2.toLowerCase()]).includes(s);
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
