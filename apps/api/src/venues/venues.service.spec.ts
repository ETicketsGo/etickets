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
  const make = (
    stored: {
      country: string | null;
      region: string | null;
      timezone: string | null;
    },
    sessions: {
      sold?: number;
      unsold?: { id: string; startsAt: Date; endsAt: Date }[];
      windows?: { id: string; salesStartAt: Date | null; salesEndAt: Date | null }[];
    } = {},
  ) => {
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const cinemaUpdateMany = jest.fn(async () => ({ count: 1 }));
    const sessionUpdate = jest.fn(async () => ({}));
    const ticketTypeUpdate = jest.fn(async () => ({}));
    const sessionCount = jest.fn(async () => sessions.sold ?? 0);
    const db: { [key: string]: unknown } = {
      venue: {
        findUnique: jest.fn(async () => ({ id: 'v1', organizationId: 'org1', ...stored })),
        update,
      },
      cinema: { updateMany: cinemaUpdateMany },
      eventSession: {
        count: sessionCount,
        findMany: jest.fn(async () => sessions.unsold ?? []),
        update: sessionUpdate,
      },
      ticketType: {
        findMany: jest.fn(async () => sessions.windows ?? []),
        update: ticketTypeUpdate,
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    const service = new VenuesService(
      db as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    return { service, update, cinemaUpdateMany, sessionUpdate, ticketTypeUpdate, sessionCount };
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

  /*
    The clock of a venue that has SOLD is locked. A ticket that says 19:00 Eastern would start
    saying 17:00 the moment the venue claimed Mountain time, and its holder would come late.
  */
  it('refuses a new clock while a session here has tickets sold or being paid for', async () => {
    const { service, update } = make(
      { country: 'United States', region: 'Idaho', timezone: 'America/New_York' },
      { sold: 2 },
    );
    await expect(
      service.update(user, 'v1', { timezone: 'America/Boise' } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('2 sessions here have tickets sold or being paid for'),
        details: expect.objectContaining({ reason: 'TIMEZONE_LOCKED_BY_SALES', soldSessions: 2 }),
      }),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('counts only bookings somebody still holds or is paying for', async () => {
    const { service, sessionCount } = make(
      { country: 'United States', region: 'Idaho', timezone: 'America/New_York' },
      { sold: 0 },
    );
    await service.update(user, 'v1', { timezone: 'America/Boise' } as never);
    const where = (sessionCount.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
      .where as { bookings: { some: { status: { in: string[] } } } };
    expect(where.bookings.some.status.in.sort()).toEqual(
      ['CONFIRMED', 'DISPUTED', 'PARTIALLY_REFUNDED', 'PENDING_PAYMENT'].sort(),
    );
  });

  it('keeps an unsold session at the local time the organizer typed', async () => {
    // 19:00 Eastern on 2026-11-20 is 00:00Z; at a Boise venue 19:00 is 02:00Z the next day.
    const { service, sessionUpdate, ticketTypeUpdate } = make(
      { country: 'United States', region: 'Idaho', timezone: 'America/New_York' },
      {
        unsold: [
          {
            id: 's1',
            startsAt: new Date('2026-11-21T00:00:00Z'),
            endsAt: new Date('2026-11-21T03:00:00Z'),
          },
        ],
        windows: [{ id: 't1', salesStartAt: null, salesEndAt: new Date('2026-11-20T23:00:00Z') }],
      },
    );
    const result = await service.update(user, 'v1', { timezone: 'America/Boise' } as never);
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        startsAt: new Date('2026-11-21T02:00:00Z'),
        endsAt: new Date('2026-11-21T05:00:00Z'),
      },
    });
    expect(ticketTypeUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { salesStartAt: null, salesEndAt: new Date('2026-11-21T01:00:00Z') },
    });
    expect(result.sessionsKeptLocalTime).toBe(1);
  });

  it('moves nothing when the new zone keeps the same clock', async () => {
    const { service, sessionCount, sessionUpdate } = make({
      country: 'India',
      region: null,
      timezone: 'Asia/Calcutta',
    });
    await service.update(user, 'v1', { timezone: 'Asia/Kolkata' } as never);
    expect(sessionCount).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });
});

/*
  A cinema at a venue is WHERE the venue is. The cinema page used to carry its own city, street
  and map, so the two could disagree; the venue edit now writes its location through.
*/
describe('VenuesService.update writes the location through to its cinemas', () => {
  const user = { id: 'u1' } as never;
  it('copies the city, street, state and zone the organizer changed, and nothing else', async () => {
    const cinemaUpdateMany = jest.fn(async () => ({ count: 1 }));
    const db: { [key: string]: unknown } = {
      venue: {
        findUnique: jest.fn(async () => ({
          id: 'v1',
          organizationId: 'org1',
          country: 'India',
          region: 'Telangana',
          timezone: 'Asia/Kolkata',
        })),
        update: jest.fn(async ({ data }: { data: unknown }) => data),
      },
      cinema: { updateMany: cinemaUpdateMany },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    const service = new VenuesService(
      db as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    await service.update(user, 'v1', {
      name: 'Renamed',
      city: 'Warangal',
      address: '1 Station Road',
    } as never);
    expect(cinemaUpdateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      data: { city: 'Warangal', address: '1 Station Road' },
    });
  });

  it("never copies an unchanged or blank answer over the cinema's own state", async () => {
    // The form sends every field on every save. A street edit must not clear a cinema's state:
    // the state decides which regulated price rules apply to it.
    const cinemaUpdateMany = jest.fn(async () => ({ count: 1 }));
    const db: { [key: string]: unknown } = {
      venue: {
        findUnique: jest.fn(async () => ({
          id: 'v1',
          organizationId: 'org1',
          city: 'Hyderabad',
          address: 'Old Road',
          country: 'India',
          region: null,
          timezone: 'Asia/Kolkata',
        })),
        update: jest.fn(async ({ data }: { data: unknown }) => data),
      },
      cinema: { updateMany: cinemaUpdateMany },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    const service = new VenuesService(
      db as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    await service.update(user, 'v1', {
      city: 'Hyderabad',
      address: 'New Road',
      country: 'India',
      region: '',
      timezone: 'Asia/Kolkata',
    } as never);
    expect(cinemaUpdateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      data: { address: 'New Road' },
    });
  });

  it('does not touch the cinemas for a rename', async () => {
    const cinemaUpdateMany = jest.fn();
    const db: { [key: string]: unknown } = {
      venue: {
        findUnique: jest.fn(async () => ({
          id: 'v1',
          organizationId: 'org1',
          country: 'India',
          region: null,
          timezone: 'Asia/Kolkata',
        })),
        update: jest.fn(async ({ data }: { data: unknown }) => data),
      },
      cinema: { updateMany: cinemaUpdateMany },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    const service = new VenuesService(
      db as never,
      { assertMember: jest.fn(async () => undefined) } as never,
    );
    await service.update(user, 'v1', { name: 'Renamed' } as never);
    expect(cinemaUpdateMany).not.toHaveBeenCalled();
  });
});
