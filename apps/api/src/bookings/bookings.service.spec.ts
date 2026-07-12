import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';

/** Builds a Prisma mock whose $transaction runs the callback with a tx mock. */
function makePrisma(
  staleBookings: Array<{ id: string; items: { ticketTypeId: string; quantity: number }[] }>,
) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    booking: { update: jest.fn().mockResolvedValue({}) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    booking: { findMany: jest.fn().mockResolvedValue(staleBookings) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, tx };
}

describe('BookingsService.releaseExpiredHolds', () => {
  it('returns 0 and does nothing when there are no stale holds', async () => {
    const { prisma } = makePrisma([]);
    const service = new BookingsService(prisma as never, {} as never, {} as never);
    const released = await service.releaseExpiredHolds();
    expect(released).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('expires each stale booking and releases its held inventory', async () => {
    const { prisma, tx } = makePrisma([
      {
        id: 'b1',
        items: [
          { ticketTypeId: 't1', quantity: 2 },
          { ticketTypeId: 't2', quantity: 1 },
        ],
      },
    ]);
    const service = new BookingsService(prisma as never, {} as never, {} as never);

    const released = await service.releaseExpiredHolds('session-1');
    expect(released).toBe(1);

    // One inventory-release statement per booking item.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    // Booking transitioned to EXPIRED.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b1' },
        data: expect.objectContaining({ status: BookingStatus.EXPIRED }),
      }),
    );
    // Outstanding payment marked failed.
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.FAILED } }),
    );
  });

  it('only queries PENDING_PAYMENT holds past their expiry', async () => {
    const { prisma } = makePrisma([]);
    const service = new BookingsService(prisma as never, {} as never, {} as never);
    await service.releaseExpiredHolds();
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(BookingStatus.PENDING_PAYMENT);
    expect(where.holdExpiresAt.lt).toBeInstanceOf(Date);
  });
});
