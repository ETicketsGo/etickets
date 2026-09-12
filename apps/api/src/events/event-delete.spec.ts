import { EventsService } from './events.service';

/**
 * An organizer deletes an event nobody has bought into — and cannot delete one somebody has.
 *
 * Requested by the owner. The rule is "no bookings of any status": a booking row, even an
 * expired hold, is a record of an attempt to buy, and settlements and payouts are financial
 * records. Those refuse the delete with a reason; everything else about the event goes with it.
 */
describe('EventsService.remove', () => {
  const owner = { id: 'u1', roles: [] } as never;

  function setup(counts: { bookings?: number; settlements?: number; payouts?: number } = {}) {
    const counters = {
      booking: { count: jest.fn().mockResolvedValue(counts.bookings ?? 0) },
      settlement: { count: jest.fn().mockResolvedValue(counts.settlements ?? 0) },
      payout: { count: jest.fn().mockResolvedValue(counts.payouts ?? 0) },
    };
    const tx = {
      ...counters,
      checkInManifest: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      checkInDevice: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      event: { delete: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      ...counters,
      event: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ev1',
          organizationId: 'org1',
          title: 'CMD-Hyd',
          status: 'PUBLISHED',
        }),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new EventsService(
      prisma as never,
      access as never,
      audit as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, tx, access, audit };
  }

  it('deletes an event with no bookings, including a published one, and records it', async () => {
    const { service, tx, audit } = setup();
    await expect(service.remove(owner, 'ev1')).resolves.toEqual({ ok: true });
    expect(tx.event.delete).toHaveBeenCalledWith({ where: { id: 'ev1' } });
    expect(tx.checkInManifest.deleteMany).toHaveBeenCalledWith({ where: { eventId: 'ev1' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EVENT_DELETED', entityId: 'ev1' }),
    );
  });

  it('checks the caller is an owner or manager of the organization', async () => {
    const { service, access } = setup();
    await service.remove(owner, 'ev1');
    expect(access.assertMember).toHaveBeenCalledWith(owner, 'org1', [
      'ORGANIZER_OWNER',
      'ORGANIZER_MANAGER',
    ]);
  });

  it('refuses while the event has any booking, and says so', async () => {
    const { service, tx } = setup({ bookings: 2 });
    await expect(service.remove(owner, 'ev1')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/2 bookings, so it cannot be deleted/),
    });
    expect(tx.event.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['a settlement', { settlements: 1 }],
    ['a payout', { payouts: 1 }],
  ])('refuses while the event has %s', async (_name, counts) => {
    const { service, tx } = setup(counts);
    await expect(service.remove(owner, 'ev1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.event.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete an event the platform team has paused', async () => {
    // Deleting would take it out of moderation — the route resume and submit already close.
    const { service, prisma, tx } = setup();
    prisma.event.findUnique.mockResolvedValue({
      id: 'ev1',
      organizationId: 'org1',
      title: 'CMD-Hyd',
      status: 'PAUSED',
      pausedByAdminAt: new Date(),
    });
    await expect(service.remove(owner, 'ev1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tx.event.delete).not.toHaveBeenCalled();
  });

  it('refuses rather than 500s when another record still points at the event', async () => {
    const { service, tx } = setup();
    tx.event.delete.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    await expect(service.remove(owner, 'ev1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
