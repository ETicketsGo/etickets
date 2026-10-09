import { CinemasService } from './cinemas.service';

/**
 * A cinema can only be pointed at its own organization's venue.
 *
 * `create` already refused a foreign venue; `update` wrote `venueId` straight from the patch,
 * so a tenant could re-home its cinema — and every show later scheduled in it — onto another
 * tenant's venue record just by naming its id.
 */
const OPERATOR = { id: 'u-owner', email: 'o@x.test', fullName: 'O', roles: [] } as never;

describe('CinemasService.create — its generated Venue preserves authoritative location', () => {
  const markets = [
    ['US', 'United States', 'Idaho', 'America/Boise'],
    ['India', 'India', 'Telangana', 'Asia/Kolkata'],
    ['Canada', 'Canada', 'Ontario', 'America/Toronto'],
    ['Australia', 'Australia', 'New South Wales', 'Australia/Sydney'],
  ] as const;

  it.each(markets)(
    '%s cinema writes its known location to the resulting Venue',
    async (label, country, region, timezone) => {
      const venueCreate = jest.fn().mockResolvedValue({ id: `venue-${label}` });
      const cinemaCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
      const prisma = {
        venue: { create: venueCreate },
        cinema: { create: cinemaCreate },
      };
      const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
      const service = new CinemasService(prisma as never, access as never);

      await service.create(OPERATOR, 'org-a', {
        name: `${label} Cinema`,
        city: label === 'Australia' ? 'Sydney' : `${label} City`,
        country,
        region,
        timezone,
      });

      expect(venueCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-a',
          country,
          region,
          timezone,
        }),
        select: { id: true },
      });
      expect(cinemaCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ venueId: `venue-${label}` }) }),
      );
    },
  );

  it('rejects an Organization A Cinema -> Organization B Venue association', async () => {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-b' }) },
      cinema: { create: jest.fn() },
    };
    const service = new CinemasService(
      prisma as never,
      {
        assertMember: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await expect(
      service.create(OPERATOR, 'org-a', {
        venueId: 'venue-b',
        name: 'Foreign Venue Cinema',
        city: 'Boise',
        timezone: 'America/Boise',
      }),
    ).rejects.toThrow(/venue not found for this organization/i);
    expect(prisma.cinema.create).not.toHaveBeenCalled();
  });

  it('preserves unknown country and region instead of inventing India', async () => {
    const venueCreate = jest.fn().mockResolvedValue({ id: 'venue-unknown' });
    const prisma = {
      venue: { create: venueCreate },
      cinema: { create: jest.fn().mockResolvedValue({ id: 'cinema-unknown', screens: [] }) },
    };
    const service = new CinemasService(
      prisma as never,
      {
        assertMember: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await service.create(OPERATOR, 'org-a', {
      name: 'Unknown Country Cinema',
      city: 'Somewhere',
      timezone: 'UTC',
    });

    expect(venueCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ country: undefined, region: undefined, timezone: 'UTC' }),
    );
    expect(venueCreate.mock.calls[0][0].data.country).not.toBe('India');
  });
});

describe('CinemasService.create - the space clock comes from where it is', () => {
  /*
    The schema defaulted every space to Asia/Kolkata when no zone was sent, so a Boise space
    created without one ran on Indian time. The zone now comes from the request, the venue,
    or the venue country - and a multi-zone country with none is refused, never guessed.
  */
  const make = (venue: { timezone: string | null; country: string | null } | null) => {
    const cinemaCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const venueCreate = jest.fn().mockResolvedValue({ id: 'venue-new' });
    const prisma = {
      venue: {
        create: venueCreate,
        findUnique: jest
          .fn()
          .mockResolvedValue(venue ? { organizationId: 'org-a', ...venue } : null),
      },
      cinema: { create: cinemaCreate },
    };
    const svc = new CinemasService(
      prisma as never,
      { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { svc, cinemaCreate, venueCreate };
  };

  it('takes the existing venue zone', async () => {
    const { svc, cinemaCreate } = make({ timezone: 'America/Boise', country: 'US' });
    await svc.create(OPERATOR, 'org-a', { venueId: 'v1', name: 'Screen', city: 'Boise' } as never);
    expect(cinemaCreate.mock.calls[0][0].data.timezone).toBe('America/Boise');
  });

  it("takes the venue country's only zone when the venue has none", async () => {
    const { svc, cinemaCreate } = make({ timezone: null, country: 'India' });
    await svc.create(OPERATOR, 'org-a', {
      venueId: 'v1',
      name: 'Screen',
      city: 'Hyderabad',
    } as never);
    expect(cinemaCreate.mock.calls[0][0].data.timezone).toBe('Asia/Kolkata');
  });

  it('refuses a multi-zone country with no zone instead of guessing India', async () => {
    const { svc, cinemaCreate } = make({ timezone: null, country: 'US' });
    await expect(
      svc.create(OPERATOR, 'org-a', { venueId: 'v1', name: 'Screen', city: 'Boise' } as never),
    ).rejects.toMatchObject({ response: { details: { reason: 'TIMEZONE_REQUIRED' } } });
    expect(cinemaCreate).not.toHaveBeenCalled();
  });

  it('gives a new US venue the zone it was told, and refuses one without', async () => {
    const told = make(null);
    await told.svc.create(OPERATOR, 'org-a', {
      name: 'Screen',
      city: 'Boise',
      country: 'US',
      timezone: 'America/Boise',
    } as never);
    expect(told.venueCreate.mock.calls[0][0].data.timezone).toBe('America/Boise');
    const untold = make(null);
    await expect(
      untold.svc.create(OPERATOR, 'org-a', {
        name: 'Screen',
        city: 'Boise',
        country: 'US',
      } as never),
    ).rejects.toMatchObject({ response: { details: { reason: 'TIMEZONE_REQUIRED' } } });
  });
});

function setup(venue: { organizationId: string } | null) {
  const prisma = {
    cinema: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cin-1',
        organizationId: 'org-a',
        venueId: 'ven-a',
        timezone: 'Asia/Kolkata',
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'cin-1',
        ...data,
        screens: [],
      })),
    },
    venue: { findUnique: jest.fn().mockResolvedValue(venue) },
    eventSession: { count: jest.fn().mockResolvedValue(0) },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  return { svc: new CinemasService(prisma as never, access as never), prisma };
}

describe('CinemasService.update — the venue must belong to the cinema’s organization', () => {
  it('refuses another organization’s venue, and writes nothing', async () => {
    const { svc, prisma } = setup({ organizationId: 'org-b' });
    await expect(svc.update(OPERATOR, 'cin-1', { venueId: 'ven-b' })).rejects.toThrow(
      /venue not found for this organization/i,
    );
    expect(prisma.cinema.update).not.toHaveBeenCalled();
  });

  it('answers a venue id that does not exist identically, so it confirms nothing', async () => {
    const { svc, prisma } = setup(null);
    await expect(svc.update(OPERATOR, 'cin-1', { venueId: 'ven-missing' })).rejects.toThrow(
      /venue not found for this organization/i,
    );
    expect(prisma.cinema.update).not.toHaveBeenCalled();
  });

  it('accepts a venue of the same organization', async () => {
    const { svc, prisma } = setup({ organizationId: 'org-a' });
    await svc.update(OPERATOR, 'cin-1', { venueId: 'ven-a2' });
    expect(prisma.cinema.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { venueId: 'ven-a2' } }),
    );
  });

  it('does not look a venue up when the patch does not change it', async () => {
    const { svc, prisma } = setup(null);
    await svc.update(OPERATOR, 'cin-1', { name: 'Renamed' });
    expect(prisma.venue.findUnique).not.toHaveBeenCalled();
    expect(prisma.cinema.update).toHaveBeenCalled();
  });
});
