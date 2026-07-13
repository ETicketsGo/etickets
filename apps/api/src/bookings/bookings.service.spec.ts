import { BookingStatus, ExperienceType, PaymentStatus } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';
import { InventoryService } from '../inventory/inventory.service';
import { GeneralAdmissionInventoryStrategy } from '../inventory/general-admission.strategy';
import { SeatBasedInventoryStrategy } from '../inventory/seat-based.strategy';
import { ExperienceTypeRegistry } from '../experience/experience-type.registry';

/** A real InventoryService wired to the real strategies, so the release path
 *  exercises the actual SQL rather than a stub. */
function realInventory(): InventoryService {
  return new InventoryService(
    new ExperienceTypeRegistry(),
    new GeneralAdmissionInventoryStrategy(),
    new SeatBasedInventoryStrategy(),
  );
}

/** Builds a Prisma mock whose $transaction runs the callback with a tx mock. */
function makePrisma(
  staleBookings: Array<{ id: string; items: { ticketTypeId: string; quantity: number }[] }>,
) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    booking: { update: jest.fn().mockResolvedValue({}) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  // Every stale booking is an EVENT experience (general-admission inventory).
  const withExperience = staleBookings.map((b) => ({
    ...b,
    eventSessionId: 'session-1',
    holdExpiresAt: new Date(0),
    event: { experienceType: ExperienceType.EVENT },
  }));
  const prisma = {
    booking: { findMany: jest.fn().mockResolvedValue(withExperience) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, tx };
}

describe('BookingsService.releaseExpiredHolds', () => {
  it('returns 0 and does nothing when there are no stale holds', async () => {
    const { prisma } = makePrisma([]);
    const service = new BookingsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      realInventory(),
    );
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
    const service = new BookingsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      realInventory(),
    );

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
    const service = new BookingsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      realInventory(),
    );
    await service.releaseExpiredHolds();
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(BookingStatus.PENDING_PAYMENT);
    expect(where.holdExpiresAt.lt).toBeInstanceOf(Date);
  });
});
