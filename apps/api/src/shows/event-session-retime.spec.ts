import { ShowsService } from './shows.service';

/**
 * Moving one date of an event that is not a film.
 *
 * The Sessions page could only add a date; one typed on the wrong evening could not be moved.
 * `retimeEventSession` takes both ends from the organizer under the film's rule: never once
 * somebody has paid for that date, or is paying for it now.
 */
describe('ShowsService.retimeEventSession', () => {
  const user = { id: 'u1', email: 'o@x', roles: ['ORGANIZER_OWNER'] } as never;
  const future = (h: number) => new Date(Date.now() + h * 3_600_000);

  function make(over: {
    movieId?: string | null;
    screenId?: string | null;
    confirmed?: number;
    pending?: number;
    startsAt?: Date;
  }) {
    const session = {
      id: 's1',
      status: 'SCHEDULED',
      startsAt: over.startsAt ?? future(48),
      endsAt: new Date((over.startsAt ?? future(48)).getTime() + 3 * 3_600_000),
      screenId: over.screenId ?? null,
      screen: null,
      event: { organizationId: 'org1', movieId: over.movieId ?? null },
    };
    const groups = [
      ...(over.confirmed ? [{ status: 'CONFIRMED', _count: { _all: over.confirmed } }] : []),
      ...(over.pending ? [{ status: 'PENDING_PAYMENT', _count: { _all: over.pending } }] : []),
    ];
    const update = jest.fn().mockImplementation(({ data }) => ({ ...session, ...data }));
    const tx = {
      eventSession: { update, findMany: jest.fn().mockResolvedValue([]) },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      eventSession: { findUnique: jest.fn().mockResolvedValue(session) },
      booking: { groupBy: jest.fn().mockResolvedValue(groups) },
      $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ShowsService(prisma as never, access as never, audit as never);
    return { service, update, access, audit };
  }

  it('moves a date nobody has bought for, both ends as given', async () => {
    const { service, update, access, audit } = make({});
    const startsAt = future(72);
    const endsAt = future(75);
    const out = await service.retimeEventSession(user, 's1', { startsAt, endsAt });
    expect(access.assertMember).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { startsAt, endsAt } });
    expect(out).toMatchObject({ sessionId: 's1', startsAt, endsAt });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SESSION_RETIMED', entityId: 's1' }),
    );
  });

  it('refuses a date somebody has paid for: they chose that time', async () => {
    const { service, update } = make({ confirmed: 1 });
    await expect(
      service.retimeEventSession(user, 's1', { startsAt: future(72), endsAt: future(75) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses while somebody is paying for it', async () => {
    const { service, update } = make({ pending: 1 });
    await expect(
      service.retimeEventSession(user, 's1', { startsAt: future(72), endsAt: future(75) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves a film show to the cinema schedule, where the end follows the runtime', async () => {
    const { service, update } = make({ movieId: 'm1', screenId: 'scr1' });
    await expect(
      service.retimeEventSession(user, 's1', { startsAt: future(72), endsAt: future(75) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a new start in the past', async () => {
    const { service, update } = make({});
    await expect(
      service.retimeEventSession(user, 's1', {
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: future(1),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(update).not.toHaveBeenCalled();
  });
});
