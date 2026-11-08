import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import {
  CITY_COOKIE,
  MARKET_COOKIE,
  citySeedFrom,
  type CitySeed,
} from '@eticketsgo/web-kit/server';
import { RECENT_COOKIE, parseRecentIds } from '@/lib/recent';
import { READER_ZONE_COOKIE, validZone } from '@/lib/reader-zone-cookie';
import { firstVisitCountry } from '@/lib/first-visit-location';
import { countryForAddress } from '@/lib/address-country';
import { PREFETCH_OFF_COOKIE } from '@/lib/prefetch';

/**
 * Where this visitor is browsing, as the server can know it: the cookies the browser mirrors
 * from its own city preference (`etg_city`, `etg_market`).
 *
 * ── WHY THE SERVER HAS TO KNOW ─────────────────────────────────────────────────────
 * Every list on the storefront is scoped to a place. While only the browser knew the place,
 * the first paint could not be the real page: the lists were empty, then asked for "everywhere",
 * then replaced by the visitor's country once the browser had resolved it. On a phone that read
 * as another page showing first and the right one jumping in over it.
 *
 * A preference, never a credential: it decides which events are drawn first, nothing else.
 * Cached per request so the layout and the page read it once.
 */
/**
 * The recently viewed event ids the browser mirrored (`RECENT_COOKIE`), so a page with a
 * "Recently viewed" rail draws it in the first paint instead of inserting it a second later.
 */
export const serverRecentIds = cache(async (): Promise<string[]> => {
  const store = await cookies();
  return parseRecentIds(store.get(RECENT_COOKIE)?.value);
});

/** The reader's time zone as the browser last reported it (`lib/reader-zone.tsx`), or undefined. */
export const serverReaderZone = cache(async (): Promise<string | undefined> => {
  const store = await cookies();
  return validZone(store.get(READER_ZONE_COOKIE)?.value);
});

export const serverCitySeed = cache(async (): Promise<CitySeed> => {
  const store = await cookies();
  const seed = citySeedFrom({
    stored: store.get(CITY_COOKIE)?.value,
    market: store.get(MARKET_COOKIE)?.value,
  });
  /*
    A first visit (no cookie says where): the edge's country, else the country of the visitor's
    network address (`lib/first-visit-location.ts`); the browser still checks it. `etg_prefetch=off` leaves it to the
    browser, like every other read, for journeys that stand in for the API there.
  */
  if (seed.ready || store.get(PREFETCH_OFF_COOKIE)?.value === 'off') return seed;
  const country = firstVisitCountry(await headers(), {
    countryFor: countryForAddress,
    // Railway's edge sets x-real-ip (and overwrites a visitor's own); nowhere else is it known.
    trustRealIp: Boolean(process.env.RAILWAY_ENVIRONMENT_ID?.trim()),
  });
  return country ? { ...seed, country, ready: true } : seed;
});
