import { gunzipSync } from 'node:zlib';
import { GEONAMES_CITIES_GZ_B64 } from './geonames-cities.data';

/**
 * Where a pair of coordinates is: the place a person would call their city.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * "Use my current location" used to answer from inventory: it looked for the nearest CINEMA
 * with coordinates and something on sale. Almost no cinema carried coordinates and no venue
 * ever did, so for Dallas, Boise, Hyderabad and Vijayawada alike it found nothing and fell
 * back to a country. Where you are is a fact about the map, not about what we sell, so it is
 * answered from the map - and only then do we look for events there.
 */
export interface GeocodedPlace {
  city: string;
  /** The same name without diacritics ("Montreal" for "Montréal"), when it differs. */
  asciiCity: string | null;
  /** State, province or territory, as GeoNames names it ("Texas", "Andhra Pradesh"). */
  region: string | null;
  /** ISO 3166-1 alpha-2, e.g. "US", "IN". */
  country: string;
  /** How far the coordinates are from the place's centre. */
  distanceKm: number;
}

export interface ReverseGeocoder {
  readonly name: string;
  /** Null when no populated place is close enough to be honest about. Never a guess. */
  reverse(latitude: number, longitude: number): Promise<GeocodedPlace | null>;
}

export const REVERSE_GEOCODER = Symbol('REVERSE_GEOCODER');

/** A geocoder that knows nothing. For `REVERSE_GEOCODER=none`, and for tests. */
export class NoReverseGeocoder implements ReverseGeocoder {
  readonly name = 'none';
  async reverse(): Promise<GeocodedPlace | null> {
    return null;
  }
}

/**
 * Further than this from any town of 15,000+ people and we do not name a city.
 *
 * Suburbs resolve to themselves (most are towns of that size in their own right) or to the
 * city they sit in. Beyond this distance the nearest town is a different place, and naming it
 * would be inventing a location - the opposite of what the button is for.
 */
export const MAX_CITY_DISTANCE_KM = 35;

interface Place {
  name: string;
  ascii: string | null;
  region: string | null;
  country: string;
  lat: number;
  lng: number;
  population: number;
}

/**
 * A borough is not the city people say they are in.
 *
 * GeoNames lists a large city's boroughs as places of their own, so the nearest centre to a
 * point in downtown Montreal is the borough "Ville-Marie", and to Secunderabad "Malkajgiri".
 * When a place at least CITY_PULL_FACTOR times larger lies within CITY_PULL_KM of the person,
 * that place is named instead. Real neighbouring cities keep their names: Brooklyn (New York
 * City is 3.4 times its size) and Plano (Dallas is 30 km away) stay themselves.
 */
const CITY_PULL_FACTOR = 5;
const CITY_PULL_KM = 12;

const EARTH_RADIUS_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Offline reverse geocoding over GeoNames' populated places of 15,000+ people (CC BY 4.0).
 *
 * Chosen over a hosted API because it is exact enough for choosing a city, costs nothing,
 * needs no key, has no rate limit, works for every country, and never sends a customer's
 * position to a third party. A hosted provider can sit behind the same interface later.
 *
 * Coordinates are used for one lookup in memory and are never stored or logged.
 */
export class OfflineCityGeocoder implements ReverseGeocoder {
  readonly name = 'geonames-offline';
  /** One-degree cells. Searching a cell and its neighbours covers MAX_CITY_DISTANCE_KM. */
  private grid: Map<string, Place[]> | null = null;

  constructor(private readonly source: string = GEONAMES_CITIES_GZ_B64) {}

  private load(): Map<string, Place[]> {
    if (this.grid) return this.grid;
    const tsv = gunzipSync(Buffer.from(this.source, 'base64')).toString('utf8');
    const grid = new Map<string, Place[]>();
    for (const line of tsv.split('\n')) {
      const [name, ascii, region, country, lat, lng, population] = line.split('\t');
      if (!name || !country) continue;
      const place: Place = {
        name,
        ascii: ascii || null,
        region: region || null,
        country,
        lat: Number(lat),
        lng: Number(lng),
        population: Number(population) || 0,
      };
      const key = `${Math.floor(place.lat)}:${Math.floor(place.lng)}`;
      const cell = grid.get(key);
      if (cell) cell.push(place);
      else grid.set(key, [place]);
    }
    this.grid = grid;
    return grid;
  }

  async reverse(latitude: number, longitude: number): Promise<GeocodedPlace | null> {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const grid = this.load();
    const baseLat = Math.floor(latitude);
    const baseLng = Math.floor(longitude);
    const near: { place: Place; km: number }[] = [];
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLng = -1; dLng <= 1; dLng += 1) {
        // Longitude wraps at the antimeridian.
        const lng = ((((baseLng + dLng + 180) % 360) + 360) % 360) - 180;
        for (const p of grid.get(`${baseLat + dLat}:${lng}`) ?? []) {
          const km = distanceKm(latitude, longitude, p.lat, p.lng);
          if (km <= MAX_CITY_DISTANCE_KM) near.push({ place: p, km });
        }
      }
    }
    if (near.length === 0) return null;
    near.sort((a, b) => a.km - b.km);
    let best = near[0].place;
    let bestKm = near[0].km;
    for (const c of near) {
      if (c.km <= CITY_PULL_KM && c.place.population >= best.population * CITY_PULL_FACTOR) {
        best = c.place;
        bestKm = c.km;
      }
    }
    return {
      city: best.name,
      asciiCity: best.ascii,
      region: best.region,
      country: best.country,
      distanceKm: Math.round(bestKm * 10) / 10,
    };
  }
}
