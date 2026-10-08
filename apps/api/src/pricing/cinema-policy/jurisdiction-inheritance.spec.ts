import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import type { PolicyContext } from './cinema-pricing-policy.resolver';

/**
 * Where a space's JURISDICTION comes from, pinned before the location migration moves it.
 *
 * -- WHY THIS FILE EXISTS ----------------------------------------------------------------
 * `resolveForCinema` assembles the context a regulated market is priced against:
 *
 *     country : cinema.country ?? cinema.venue?.country
 *     region  : cinema.region  ?? cinema.venue?.region
 *     city    : cinema.city    ?? cinema.venue?.city
 *     district / localBodyType : the cinema's own, with NO venue fallback
 *
 * India's cinema pricing orders band on exactly these. Andhra Pradesh prices by local body,
 * and two cinemas in one district can fall under different ones - which is why the class
 * comment says a venue "may be shared by several cinemas that are classified differently".
 *
 * There were 83 tests over this policy engine and NOT ONE of them exercised the venue
 * fallback. The migration that makes the venue authoritative for location changes this exact
 * code path, so it was about to be moved with no characterisation of what it currently does.
 *
 * These tests assert the ASSEMBLY, not any rate. No amount appears here, and none should:
 * the engine holds no rupee of any government order and neither does its test suite.
 */
describe('a space inherits its jurisdiction from its venue, but not its classification', () => {
  /**
   * Captures the context `resolveForCinema` builds, without a database.
   *
   * `resolve` is stubbed rather than mocked at the Prisma layer because the question here is
   * purely "what context was assembled" - loading rows would test the resolver again, which
   * 83 other tests already do.
   */
  function capture() {
    const service = new CinemaPricingPolicyService({} as never);
    const seen: PolicyContext[] = [];
    jest.spyOn(service, 'resolve').mockImplementation(async (ctx: PolicyContext) => {
      seen.push(ctx);
      return { status: 'UNREGULATED' } as never;
    });
    return { service, seen };
  }

  const space = (over: Record<string, unknown> = {}) =>
    ({
      country: null,
      region: null,
      district: null,
      city: null,
      localBodyType: null,
      cinemaFormat: null,
      climateType: null,
      venue: null,
      ...over,
    }) as never;

  const resolve = async (s: unknown) => {
    const { service, seen } = capture();
    await service.resolveForCinema(s as never, 'INR', ['GOLD'], new Date('2026-01-15T00:00:00Z'));
    return seen[0];
  };

  it('takes the venue’s country, region and city when the space has none', async () => {
    // The gap-filling case, and the one the migration generalises: a space that never
    // carried a location of its own is priced where its venue is.
    const ctx = await resolve(
      space({ venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' } }),
    );
    expect(ctx.country).toBe('India');
    expect(ctx.region).toBe('Andhra Pradesh');
    expect(ctx.city).toBe('Vijayawada');
  });

  it('prefers the space’s own values over the venue’s', async () => {
    /*
      Today the space wins. Recording it because the migration INVERTS this - the venue
      becomes authoritative - and that inversion must be a deliberate, reviewed change rather
      than something noticed later in a rate dispute.
    */
    const ctx = await resolve(
      space({
        country: 'India',
        region: 'Telangana',
        city: 'Hyderabad',
        venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' },
      }),
    );
    expect(ctx.region).toBe('Telangana');
    expect(ctx.city).toBe('Hyderabad');
  });

  it('fills each field independently, not all-or-nothing', async () => {
    // A space can know its city and not its state. Resolving per field is what makes a
    // partially filled space usable instead of refused.
    const ctx = await resolve(
      space({
        city: 'Guntur',
        venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' },
      }),
    );
    expect(ctx.city).toBe('Guntur');
    expect(ctx.region).toBe('Andhra Pradesh');
    expect(ctx.country).toBe('India');
  });

  it('never takes district or local body from the venue', async () => {
    /*
      THE ONE THAT MUST NOT CHANGE.

      Andhra Pradesh bands by local body, and two cinemas in one district can fall under
      different ones - so these are facts about the SPACE. If a venue could supply them, two
      spaces in one building would be forced into one classification and one of them would be
      priced under an order that does not govern it.

      The migration moves country/region/city to the venue. It must leave these alone.
    */
    const ctx = await resolve(
      space({
        venue: {
          country: 'India',
          region: 'Andhra Pradesh',
          city: 'Vijayawada',
          // Deliberately offered, and deliberately ignored.
          district: 'Krishna',
          localBodyType: 'MUNICIPAL_CORPORATION',
        },
      }),
    );
    expect(ctx.district).toBeNull();
    expect(ctx.localBodyType).toBeNull();
  });

  it('keeps the space’s own district and classification', async () => {
    const ctx = await resolve(
      space({
        district: 'Krishna',
        localBodyType: 'MUNICIPAL_CORPORATION',
        cinemaFormat: 'MULTIPLEX',
        climateType: 'AC',
        venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' },
      }),
    );
    expect(ctx.district).toBe('Krishna');
    expect(ctx.localBodyType).toBe('MUNICIPAL_CORPORATION');
    expect(ctx.cinemaFormat).toBe('MULTIPLEX');
    expect(ctx.climateType).toBe('AC');
  });

  it('resolves to nothing rather than guessing when neither knows', async () => {
    // No jurisdiction is not an error here - it is an unregulated market, which is most of
    // the world. What matters is that nothing is invented to fill the hole.
    const ctx = await resolve(space({ venue: null }));
    expect(ctx.country).toBeNull();
    expect(ctx.region).toBeNull();
    expect(ctx.city).toBeNull();
  });

  it('treats a space with no venue the same as one whose venue knows nothing', async () => {
    const withoutVenue = await resolve(space({ country: 'India' }));
    const withEmptyVenue = await resolve(
      space({ country: 'India', venue: { country: null, region: null, city: null } }),
    );
    expect(withEmptyVenue).toEqual(withoutVenue);
  });

  it('passes the currency and seat categories through untouched', async () => {
    // Guards the signature itself: a refactor that drops an argument would otherwise price a
    // sale against the wrong currency without failing anything.
    const { service, seen } = capture();
    await service.resolveForCinema(
      space({ venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' } }),
      'INR',
      ['GOLD', 'SILVER'],
      new Date('2026-01-15T00:00:00Z'),
      ['Balcony'],
    );
    expect(seen[0].currency).toBe('INR');
    expect(seen[0].seatCategories).toEqual(['GOLD', 'SILVER']);
    expect(seen[0].unmappedSeatCategories).toEqual(['Balcony']);
  });
});
