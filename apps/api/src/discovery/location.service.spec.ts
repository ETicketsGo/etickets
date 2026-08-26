import { LocationService } from './location.service';

/**
 * Guessing where somebody is, and refusing to guess when we cannot.
 *
 * These tests are written against the failure the feature can cause rather than the happy
 * path it enables. A location feature that is merely inaccurate costs a click; one that
 * confidently filters the homepage down to nothing looks like a dead platform.
 */

// Pass-through cache: the producer always runs, so these exercise the real query shaping.
const passthroughCache = () =>
  ({
    getOrSet: jest.fn((_k: string, _t: number, producer: () => Promise<unknown>) => producer()),
  }) as never;

type VenueRow = { city: string; country: string; _count: { events: number } };
type CinemaRow = { city: string; latitude: number | null; longitude: number | null };

const prismaWith = (venues: VenueRow[], cinemas: CinemaRow[] = []) =>
  ({
    venue: { findMany: jest.fn().mockResolvedValue(venues) },
    cinema: { findMany: jest.fn().mockResolvedValue(cinemas) },
  }) as never;

const venue = (city: string, country = 'India', events = 1): VenueRow => ({
  city,
  country,
  _count: { events },
});

// Real coordinates, so "is Thane near Mumbai" is a question about the world and not about
// numbers chosen to make the assertion pass.
const MUMBAI = { lat: 19.076, lng: 72.8777 };
const THANE = { lat: 19.2183, lng: 72.9781 }; // ~20km from Mumbai
const DELHI = { lat: 28.6139, lng: 77.209 }; // ~1150km from Mumbai
const LONDON = { lat: 51.5072, lng: -0.1276 };

describe('LocationService', () => {
  describe('cities', () => {
    it('folds venues in the same city into one entry and sums what is on sale', async () => {
      const service = new LocationService(
        prismaWith([venue('Mumbai', 'India', 3), venue('mumbai', 'India', 2)]),
        passthroughCache(),
      );
      expect(await service.cities()).toEqual([{ city: 'Mumbai', country: 'India', eventCount: 5 }]);
    });

    it('keeps the first spelling for display rather than a normalised one', async () => {
      // "bengaluru" in the picker would look like a bug to anybody reading it.
      const service = new LocationService(
        prismaWith([venue('Bengaluru'), venue('bengaluru')]),
        passthroughCache(),
      );
      expect((await service.cities())[0].city).toBe('Bengaluru');
    });

    it('orders by how much is on sale, then alphabetically', async () => {
      const service = new LocationService(
        prismaWith([
          venue('Pune', 'India', 1),
          venue('Delhi', 'India', 9),
          venue('Agra', 'India', 1),
        ]),
        passthroughCache(),
      );
      expect((await service.cities()).map((c) => c.city)).toEqual(['Delhi', 'Agra', 'Pune']);
    });
  });

  describe('resolve', () => {
    const service = (venues: VenueRow[], cinemas: CinemaRow[] = []) =>
      new LocationService(prismaWith(venues, cinemas), passthroughCache());

    it('says it does not know rather than inventing an answer', async () => {
      const result = await service([venue('Mumbai')]).resolve({ headers: {} });
      expect(result).toMatchObject({ country: null, city: null, source: 'none', confident: false });
    });

    it('never returns a city we cannot sell in, even when the network names one', async () => {
      // The core guarantee. A header city we do not serve, applied as a filter, empties the
      // homepage — so it is dropped and only the country survives as a hint.
      const result = await service([venue('Mumbai'), venue('Delhi')]).resolve({
        headers: { 'cf-ipcountry': 'IN', 'cf-ipcity': 'Nagpur' },
      });
      expect(result.city).toBeNull();
      expect(result.country).toBe('IN');
    });

    it('accepts a network city we do sell in, but asks the client to confirm it', async () => {
      const result = await service([venue('Mumbai'), venue('Delhi')]).resolve({
        headers: { 'cf-ipcity': 'mumbai' },
      });
      expect(result.city).toBe('Mumbai');
      expect(result.source).toBe('network');
      // An IP is wrong for anyone on a VPN. Applied silently, that is a filter nobody chose.
      expect(result.confident).toBe(false);
    });

    it('picks the only city in a country, because there is nothing to choose between', async () => {
      const result = await service([venue('Mumbai', 'India')]).resolve({
        headers: { 'cf-ipcountry': 'IN' },
      });
      expect(result.city).toBe('Mumbai');
    });

    it('leaves the city unset when a country has several, rather than picking the biggest', async () => {
      const result = await service([
        venue('Mumbai', 'India', 9),
        venue('Delhi', 'India', 1),
      ]).resolve({ headers: { 'cf-ipcountry': 'IN' } });
      expect(result.city).toBeNull();
    });

    it("treats Cloudflare's unknown markers as unknown, not as countries", async () => {
      for (const marker of ['XX', 'T1']) {
        const result = await service([venue('Mumbai')]).resolve({
          headers: { 'cf-ipcountry': marker },
        });
        // 'XX' would match no venue country, producing a hint that can only mislead.
        expect(result.source).toBe('none');
      }
    });

    it('matches an ISO country code against the country name a venue stores', async () => {
      const result = await service([venue('Austin', 'United States')]).resolve({
        headers: { 'x-vercel-ip-country': 'us' },
      });
      expect(result.city).toBe('Austin');
    });

    it('resolves coordinates to the nearest sellable city and trusts the answer', async () => {
      const result = await service(
        [venue('Mumbai'), venue('Delhi')],
        [
          { city: 'Mumbai', latitude: MUMBAI.lat, longitude: MUMBAI.lng },
          { city: 'Delhi', latitude: DELHI.lat, longitude: DELHI.lng },
        ],
      ).resolve({ headers: {}, latitude: THANE.lat, longitude: THANE.lng });

      expect(result.city).toBe('Mumbai');
      expect(result.source).toBe('coordinates');
      // The one source the person actively consented to, so it applies without a prompt.
      expect(result.confident).toBe(true);
    });

    it('refuses a nearest city that is not actually near', async () => {
      // Someone in London is better served by "pick a city" than by being told their local
      // cinema is in Mumbai.
      const result = await service(
        [venue('Mumbai')],
        [{ city: 'Mumbai', latitude: MUMBAI.lat, longitude: MUMBAI.lng }],
      ).resolve({ headers: {}, latitude: LONDON.lat, longitude: LONDON.lng });

      expect(result.city).toBeNull();
      expect(result.source).toBe('none');
    });

    it('ignores a nearby cinema that has nothing on sale', async () => {
      // A cinema with no upcoming shows is a building, not an answer.
      const result = await service(
        [venue('Delhi')],
        [{ city: 'Mumbai', latitude: MUMBAI.lat, longitude: MUMBAI.lng }],
      ).resolve({ headers: {}, latitude: MUMBAI.lat, longitude: MUMBAI.lng });

      expect(result.city).toBeNull();
    });

    it('prefers coordinates over the network when both are present', async () => {
      const result = await service(
        [venue('Mumbai'), venue('Delhi')],
        [{ city: 'Delhi', latitude: DELHI.lat, longitude: DELHI.lng }],
      ).resolve({
        headers: { 'cf-ipcity': 'Mumbai' },
        latitude: DELHI.lat,
        longitude: DELHI.lng,
      });
      expect(result.city).toBe('Delhi');
    });

    it('uses the device region only as a country hint, never as a city', async () => {
      const result = await service([venue('Mumbai', 'India')]).resolve({
        headers: {},
        deviceRegion: 'in',
      });
      // The device knows where it was configured, not where it is — so no city is implied
      // even though only one is sellable.
      expect(result).toMatchObject({ country: 'IN', city: null, source: 'device-region' });
    });

    it('always returns the full city list, so the client can offer a change immediately', async () => {
      const result = await service([venue('Mumbai'), venue('Delhi')]).resolve({ headers: {} });
      expect(result.cities.map((c) => c.city).sort()).toEqual(['Delhi', 'Mumbai']);
    });
  });
});
