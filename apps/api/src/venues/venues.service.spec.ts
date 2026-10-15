import { VenuesService } from './venues.service';

/**
 * A venue's time zone, when the organizer did not pick one.
 *
 * Found on QA: a Hyderabad concert at 19:00 read "7:30 am" on the payment page to a buyer whose
 * browser was in the United States, because the venue had no zone and the page fell back to
 * the reader's. Where the country has one zone the venue gets it; where it has several, it is
 * still never guessed.
 */
describe('VenuesService.create time zone', () => {
  const user = { id: 'u1' } as never;
  const make = () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const service = new VenuesService(
      { venue: { create } } as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    return { service, create };
  };
  const base = { name: 'Hall', city: 'Hyderabad' };

  it('stores the only zone a single-zone country has', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', { ...base, country: 'IN' } as never);
    expect(create.mock.calls[0][0].data.timezone).toBe('Asia/Kolkata');
  });

  it('never guesses for a country with several zones', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', { ...base, city: 'Dallas', country: 'US' } as never);
    expect(create.mock.calls[0][0].data.timezone).toBeUndefined();
  });

  it('takes the zone the state keeps when no zone was sent', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', {
      ...base,
      city: 'Meridian',
      country: 'United States',
      region: 'Idaho',
    } as never);
    expect(create.mock.calls[0][0].data.timezone).toBe('America/Boise');
  });

  it('keeps a zone that was sent even when the state usually keeps another', async () => {
    // El Paso, Texas is on Mountain time. A sent zone is an answer, never overridden by a table.
    const { service, create } = make();
    await service.create(user, 'org1', {
      ...base,
      city: 'El Paso',
      country: 'United States',
      region: 'Texas',
      timezone: 'America/Denver',
    } as never);
    expect(create.mock.calls[0][0].data.timezone).toBe('America/Denver');
  });

  it('keeps the zone the organizer chose', async () => {
    const { service, create } = make();
    await service.create(user, 'org1', {
      ...base,
      country: 'IN',
      timezone: 'Asia/Dubai',
    } as never);
    expect(create.mock.calls[0][0].data.timezone).toBe('Asia/Dubai');
  });
});

describe('VenuesService.update time zone', () => {
  const user = { id: 'u1' } as never;
  const make = (stored: {
    country: string | null;
    region: string | null;
    timezone: string | null;
  }) => {
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const service = new VenuesService(
      {
        venue: {
          findUnique: jest.fn(async () => ({ id: 'v1', organizationId: 'org1', ...stored })),
          update,
        },
      } as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    return { service, update };
  };

  it('fills a venue that has no zone from its state', async () => {
    const { service, update } = make({ country: 'United States', region: null, timezone: null });
    await service.update(user, 'v1', { region: 'Arizona' } as never);
    expect(update.mock.calls[0][0].data.timezone).toBe('America/Phoenix');
  });

  it('never moves a stored zone because the state changed', async () => {
    const { service, update } = make({
      country: 'United States',
      region: 'Idaho',
      timezone: 'America/New_York',
    });
    await service.update(user, 'v1', { region: 'Texas' } as never);
    expect(update.mock.calls[0][0].data.timezone).toBeUndefined();
  });

  it('writes the zone the organizer sent', async () => {
    const { service, update } = make({
      country: 'United States',
      region: 'Idaho',
      timezone: 'America/New_York',
    });
    await service.update(user, 'v1', { timezone: 'America/Boise' } as never);
    expect(update.mock.calls[0][0].data.timezone).toBe('America/Boise');
  });
});
