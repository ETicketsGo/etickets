import { LocationService } from './location.service';
import { NoReverseGeocoder, OfflineCityGeocoder } from './geocoding/reverse-geocoder';

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
  describe('cities search', () => {
    /*
      The picker cannot show hundreds of cities, so the filtering has to happen here. These
      tests are about what somebody typing three letters expects to get back.
    */
    const svc = (venues: VenueRow[]) => new LocationService(prismaWith(venues), passthroughCache());

    it('matches a prefix of the name, not a substring of it', async () => {
      // "san" should offer San Francisco. It should not offer Rosande just because the
      // letters appear in the middle of it — that is a search that feels broken.
      const result = await svc([venue('San Francisco', 'USA'), venue('Rosande', 'USA')]).cities({
        q: 'san',
      });
      expect(result.map((c) => c.city)).toEqual(['San Francisco']);
    });

    it('matches any word of a multi-word city, so "york" finds New York', async () => {
      const result = await svc([venue('New York', 'USA')]).cities({ q: 'york' });
      expect(result.map((c) => c.city)).toEqual(['New York']);
    });

    it('ignores case, because nobody types Bengaluru with a capital B in a search box', async () => {
      const result = await svc([venue('Bengaluru')]).cities({ q: 'BENG' });
      expect(result.map((c) => c.city)).toEqual(['Bengaluru']);
    });

    it('narrows to a country in either spelling', async () => {
      const result = await svc([venue('Mumbai', 'India'), venue('Meridian', 'USA')]).cities({
        country: 'IN',
      });
      expect(result.map((c) => c.city)).toEqual(['Mumbai']);
    });

    it('caps the result, so a two-letter prefix cannot return the whole platform', async () => {
      const many = Array.from({ length: 30 }, (_, i) => venue(`Mumbai${i}`));
      const result = await svc(many).cities({ q: 'mumbai', limit: 5 });
      expect(result).toHaveLength(5);
    });

    it('returns the busiest cities when nothing is typed, which is what a picker opens on', async () => {
      const result = await svc([venue('Small', 'India', 1), venue('Busy', 'India', 9)]).cities({
        limit: 1,
      });
      expect(result.map((c) => c.city)).toEqual(['Busy']);
    });

    it('returns everything when asked for nothing, so existing callers are unaffected', async () => {
      const result = await svc([venue('Mumbai'), venue('Delhi')]).cities();
      expect(result).toHaveLength(2);
    });
  });

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

  describe('cities search anywhere', () => {
    /*
      A customer in a city we sell nothing in must still be able to type it and choose it, so
      the page can say "nothing here yet" about THEIR city instead of acting as if it did not
      exist. Real places from the offline dataset; sellable cities always come first.
    */
    const geocoder = new OfflineCityGeocoder();
    const svc = (venues: VenueRow[]) =>
      new LocationService(prismaWith(venues), passthroughCache(), geocoder);

    it('finds a real city with nothing on sale, marked as having no events', async () => {
      const found = await svc([venue('Mumbai')]).cities({ q: 'boise', anywhere: true, limit: 8 });
      expect(found[0]).toMatchObject({
        city: 'Boise',
        country: 'US',
        eventCount: 0,
        region: 'Idaho',
      });
    });

    it('is off unless asked for, so the sellable-only search is unchanged', async () => {
      const found = await svc([venue('Mumbai')]).cities({ q: 'boise', limit: 8 });
      expect(found).toEqual([]);
    });

    it('puts sellable cities first and never repeats one as an empty duplicate', async () => {
      const found = await svc([venue('Hyderabad', 'India', 3)]).cities({
        q: 'hyder',
        anywhere: true,
        limit: 8,
      });
      expect(found[0]).toMatchObject({ city: 'Hyderabad', eventCount: 3 });
      // Hyderabad in Pakistan (Sindh) is a different place and may appear; India's may not.
      const indianEmpties = found.filter(
        (c) => c.eventCount === 0 && c.city === 'Hyderabad' && c.country === 'IN',
      );
      expect(indianEmpties).toHaveLength(0);
    });

    it('matches without accents and respects the country filter', async () => {
      const found = await svc([]).cities({ q: 'montre', anywhere: true, country: 'CA', limit: 8 });
      expect(found.map((c) => c.city)).toContain('Montréal');
      expect(found.every((c) => c.country === 'CA')).toBe(true);
    });

    it("puts the visitor's own country first among empty places, without hiding the rest", async () => {
      const plain = await svc([]).cities({ q: 'hyder', anywhere: true, limit: 8 });
      const fromPakistan = await svc([]).cities({
        q: 'hyder',
        anywhere: true,
        prefer: 'PK',
        limit: 8,
      });
      expect(plain[0]).toMatchObject({ city: 'Hyderabad', country: 'IN' });
      expect(fromPakistan[0]).toMatchObject({ city: 'Hyderabad', country: 'PK' });
      expect(fromPakistan.map((c) => c.country)).toContain('IN');
    });

    it('needs a typed name - it never lists the world', async () => {
      expect(await svc([]).cities({ anywhere: true, limit: 8 })).toEqual([]);
      expect(await svc([]).cities({ q: 'b', anywhere: true, limit: 8 })).toEqual([]);
    });

    it('finds nothing when the geocoder is switched off', async () => {
      const found = await new LocationService(
        prismaWith([]),
        passthroughCache(),
        new NoReverseGeocoder(),
      ).cities({ q: 'boise', anywhere: true, limit: 8 });
      expect(found).toEqual([]);
    });
  });

  describe('resolve', () => {
    // The real offline geocoder: these tests are about real places, not stubbed answers.
    const geocoder = new OfflineCityGeocoder();
    const service = (venues: VenueRow[], cinemas: CinemaRow[] = []) =>
      new LocationService(prismaWith(venues, cinemas), passthroughCache(), geocoder);

    it('says it does not know rather than inventing an answer', async () => {
      const result = await service([venue('Mumbai')]).resolve({ headers: {} });
      expect(result).toMatchObject({ country: null, city: null, source: 'none', confident: false });
    });

    it('offers the network city as a suggestion even where nothing is on sale', async () => {
      // Where somebody is does not depend on what we sell. The guess is still only a
      // suggestion (not confident), so nothing is applied without the person confirming.
      const result = await service([venue('Mumbai'), venue('Delhi')]).resolve({
        headers: { 'cf-ipcountry': 'IN', 'cf-ipcity': 'Nagpur' },
      });
      expect(result).toMatchObject({ city: 'Nagpur', country: 'IN', confident: false });
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

    it('never picks a city from inventory when only the country is known', async () => {
      // It used to pick the country's only city with events, which put everybody in the
      // United States in Boise.
      const result = await service([venue('Mumbai', 'India')]).resolve({
        headers: { 'cf-ipcountry': 'IN' },
      });
      expect(result.city).toBeNull();
      expect(result.country).toBe('IN');
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
      expect(result.topCities.map((c) => c.city)).toEqual(['Austin']);
      expect(result.city).toBeNull();
    });

    it.each([
      ['Dallas', 32.7767, -96.797, 'Texas', 'US'],
      ['Boise', 43.615, -116.2023, 'Idaho', 'US'],
      ['Hyderabad', 17.385, 78.4867, 'Telangana', 'IN'],
      ['Vijayawada', 16.5062, 80.648, 'Andhra Pradesh', 'IN'],
    ])(
      'names %s from its coordinates with nothing on sale there',
      async (city, lat, lng, region, country) => {
        // THE BUG. Coordinates used to resolve only through a cinema with stock, so all four
        // of these came back with no city. The database here has no events anywhere near.
        const result = await service([]).resolve({ headers: {}, latitude: lat, longitude: lng });
        expect(result).toMatchObject({
          city,
          region,
          country,
          source: 'coordinates',
          confident: true,
          scopeCountry: country,
        });
      },
    );

    it('works outside the markets we sell in, too', async () => {
      // Worldwide by design: London resolves to London, and simply has nothing on sale.
      const result = await service([venue('Mumbai')]).resolve({
        headers: {},
        latitude: LONDON.lat,
        longitude: LONDON.lng,
      });
      expect(result).toMatchObject({ city: 'London', country: 'GB', topCities: [] });
    });

    it('names the city the person is in, never the nearest city with events', async () => {
      // Thane is twenty kilometres from Mumbai, which has everything on sale. It is Thane.
      const result = await service(
        [venue('Mumbai')],
        [{ city: 'Mumbai', latitude: MUMBAI.lat, longitude: MUMBAI.lng }],
      ).resolve({ headers: {}, latitude: THANE.lat, longitude: THANE.lng });
      expect(result.city).toBe('Thane');
      expect(result.confident).toBe(true);
    });

    it('names no city in open water, rather than the nearest one ashore', async () => {
      const result = await service([venue('Mumbai')]).resolve({
        headers: {},
        latitude: 30,
        longitude: -40,
      });
      expect(result.city).toBeNull();
      expect(result.source).toBe('none');
    });

    it('names no city when the geocoder is switched off - it never invents one', async () => {
      const result = await new LocationService(
        prismaWith([venue('Mumbai')]),
        passthroughCache(),
        new NoReverseGeocoder(),
      ).resolve({ headers: {}, latitude: MUMBAI.lat, longitude: MUMBAI.lng, deviceRegion: 'in' });
      expect(result.city).toBeNull();
      expect(result.scopeCountry).toBe('IN');
    });

    it('uses our spelling of the same city, so its events are found', async () => {
      // GeoNames says "Montréal"; a venue typed "Montreal". Same place, our spelling.
      const result = await service([venue('Montreal', 'Canada')]).resolve({
        headers: {},
        latitude: 45.5017,
        longitude: -73.5673,
      });
      expect(result).toMatchObject({ city: 'Montreal', region: 'Quebec', country: 'CA' });
    });

    it('falls back to the country when coordinates name no city', async () => {
      // Open water with a device region: no city is invented, the country still scopes.
      const result = await service([venue('Mumbai')]).resolve({
        headers: {},
        latitude: 30,
        longitude: -40,
        deviceRegion: 'gb',
      });
      expect(result.city).toBeNull();
      expect(result.scopeCountry).toBe('GB');
      expect(result.topCities).toEqual([]);
    });

    it('keeps a city that has nothing on sale instead of moving to one that does', async () => {
      // Standing in Mumbai with events only in Delhi: the answer is Mumbai, and empty.
      const result = await service([venue('Delhi')]).resolve({
        headers: {},
        latitude: MUMBAI.lat,
        longitude: MUMBAI.lng,
      });
      expect(result.city).toBe('Mumbai');
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

    it('scopes to the country it thinks they are in, even when we sell nothing there', async () => {
      /*
        The owner's rule, and the reverse of what this returned before.

        It used to null the scope for a country we had no inventory in, on the reasoning that
        an empty storefront looks broken. But nulling a scope does not narrow a page, it
        REMOVES the filter: the one visitor we had nothing for was the one shown everything,
        so somebody in the United States met a storefront full of Indian events. Empty is the
        honest answer and the empty state explains it; the picker's "Browse every country" is how
        a person chooses to look further, deliberately.
      */
      const result = await service([venue('Mumbai', 'India')]).resolve({
        headers: {},
        deviceRegion: 'us',
      });

      expect(result.country).toBe('US');
      expect(result.scopeCountry).toBe('US');
      // And it offers nothing, rather than offering Mumbai to somebody in Idaho.
      expect(result.topCities).toEqual([]);
    });

    it('hands back a country scope when we do sell there', async () => {
      const result = await service([venue('Mumbai', 'India')]).resolve({
        headers: {},
        deviceRegion: 'in',
      });
      expect(result.scopeCountry).toBe('IN');
    });

    it('never scopes when it has no idea where they are', async () => {
      const result = await service([venue('Mumbai', 'India')]).resolve({ headers: {} });
      expect(result.scopeCountry).toBeNull();
    });

    it('offers a few cities up front so the client can suggest a change immediately', async () => {
      const result = await service([venue('Mumbai'), venue('Delhi')]).resolve({ headers: {} });
      expect(result.topCities.map((c) => c.city).sort()).toEqual(['Delhi', 'Mumbai']);
    });

    it('offers cities in the country it thinks the visitor is in, ahead of busier ones elsewhere', async () => {
      /*
        Ordering by inventory alone would open the picker on Mumbai for somebody in Idaho,
        which reads as "this platform is not for you". The country hint is weak, so it
        chooses what to OFFER and never what to apply.
      */
      const result = await service([
        venue('Mumbai', 'India'),
        venue('Mumbai', 'India'),
        venue('Meridian', 'USA'),
      ]).resolve({ headers: {}, deviceRegion: 'us' });

      expect(result.topCities.map((c) => c.city)).toEqual(['Meridian']);
    });

    it('offers nothing when we sell nothing in their country, rather than another continent', async () => {
      /*
        A visitor in Germany is not helped by being offered Mumbai. The picker keeps its
        search box and its "Browse every country" way out, so looking further is still one tap —
        it is just no longer what happens to somebody who asked for nothing.
      */
      const result = await service([venue('Mumbai', 'India')]).resolve({
        headers: {},
        deviceRegion: 'de',
      });
      expect(result.topCities).toEqual([]);
    });

    it('still offers the busiest cities when it has no idea where they are', async () => {
      // Not a fallback: with no country there is nothing narrower to offer than everywhere.
      const result = await service([venue('Mumbai', 'India')]).resolve({ headers: {} });
      expect(result.topCities.map((c) => c.city)).toEqual(['Mumbai']);
      expect(result.scopeCountry).toBeNull();
    });

    it('caps what it offers, because the picker is a search and not a menu', async () => {
      const many = Array.from({ length: 20 }, (_, i) => venue(`City${i}`, 'India'));
      const result = await service(many).resolve({ headers: {} });
      expect(result.topCities).toHaveLength(8);
    });
  });
});
