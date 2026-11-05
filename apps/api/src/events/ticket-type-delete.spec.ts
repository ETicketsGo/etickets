import { HttpStatus } from '@nestjs/common';
import { EventsService } from './events.service';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * QA 2026-10-28: deleting a ticket type after a full refund was a 500. The sold/held counters
 * are back to 0, but the refunded tickets and booking lines still reference the type, so the
 * foreign key threw. It is now a 409 TICKET_TYPE_HAS_HISTORY, and no history is deleted.
 */
describe('EventsService.deleteTicketType', () => {
  const owner = { id: 'u1', roles: [] } as never;

  function setup(
    opts: {
      sold?: number;
      held?: number;
      bookingItems?: number;
      tickets?: number;
      bundleItems?: number;
    } = {},
  ) {
    const prisma = {
      ticketType: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tt1',
          name: 'General',
          inventory: { quantitySold: opts.sold ?? 0, quantityHeld: opts.held ?? 0 },
          eventSession: { event: { organizationId: 'org1' } },
        }),
        delete: jest.fn().mockReturnValue('delete-op'),
      },
      ticketInventory: { deleteMany: jest.fn().mockReturnValue('inventory-op') },
      bookingItem: { count: jest.fn().mockResolvedValue(opts.bookingItems ?? 0) },
      ticket: { count: jest.fn().mockResolvedValue(opts.tickets ?? 0) },
      bundleItem: { count: jest.fn().mockResolvedValue(opts.bundleItems ?? 0) },
      $transaction: jest.fn().mockResolvedValue([]),
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
    return { service, prisma, audit };
  }

  it('deletes a ticket type nobody ever booked', async () => {
    const { service, prisma, audit } = setup();
    await expect(service.deleteTicketType(owner, 'tt1')).resolves.toEqual({ ok: true });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TICKET_TYPE_DELETED', entityId: 'tt1' }),
    );
  });

  it('refuses with 409 TICKET_TYPE_HAS_HISTORY after a full refund (counters 0, tickets remain)', async () => {
    const { service, prisma } = setup({ bookingItems: 1, tickets: 2 });
    const err = await service.deleteTicketType(owner, 'tt1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect(err).toMatchObject({
      code: ErrorCodes.TICKET_TYPE_HAS_HISTORY,
      details: { bookingItems: 1, tickets: 2 },
    });
    expect((err as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
    // Nothing is deleted: not the type, not its inventory, not the history.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses when only booking lines name it', async () => {
    const { service } = setup({ bookingItems: 3 });
    await expect(service.deleteTicketType(owner, 'tt1')).rejects.toMatchObject({
      code: 'TICKET_TYPE_HAS_HISTORY',
    });
  });

  it('refuses with 409 TICKET_TYPE_IN_BUNDLE when only a bundle names it', async () => {
    const { service, prisma, audit } = setup({ bundleItems: 2 });
    const err = await service.deleteTicketType(owner, 'tt1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect(err).toMatchObject({
      code: ErrorCodes.TICKET_TYPE_IN_BUNDLE,
      details: { bundleItems: 2 },
    });
    expect((err as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as AppException).message).not.toMatch(/orders/);
    // eslint-disable-next-line no-control-regex
    expect((err as AppException).message).toMatch(/^[\x00-\x7F]*$/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('history outranks the bundle check', async () => {
    const { service, prisma } = setup({ tickets: 1, bundleItems: 1 });
    await expect(service.deleteTicketType(owner, 'tt1')).rejects.toMatchObject({
      code: 'TICKET_TYPE_HAS_HISTORY',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps a foreign-key failure from a late booking to the same 409, never a 500', async () => {
    const { service, prisma, audit } = setup();
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: 'P2003' }));
    const err = await service.deleteTicketType(owner, 'tt1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'TICKET_TYPE_HAS_HISTORY' });
    expect((err as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('still refuses live sales or holds with the existing message', async () => {
    const { service } = setup({ held: 1 });
    await expect(service.deleteTicketType(owner, 'tt1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
