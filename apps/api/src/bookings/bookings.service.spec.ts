import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';
import { InventoryService } from '../inventory/inventory.service';
import { GeneralAdmissionInventoryStrategy } from '../inventory/general-admission.strategy';
import { SeatBasedInventoryStrategy } from '../inventory/seat-based.strategy';
import { ExperienceTypeRegistry } from '../experience/experience-type.registry';
import { MetricsService } from '../metrics/metrics.service';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';

/** A real InventoryService wired to the real strategies, so the release path
 *  exercises the actual SQL rather than a stub. */
function realInventory(): InventoryService {
  return new InventoryService(
    new ExperienceTypeRegistry(),
    new GeneralAdmissionInventoryStrategy(),
    new SeatBasedInventoryStrategy(),
  );
}

interface Stale {
  id: string;
  seatBased?: boolean;
  items: { ticketTypeId: string | null; addOnId?: string | null; quantity: number }[];
}

/**
 * Builds a Prisma mock whose $transaction runs the callback with a tx mock.
 *
 * `claimed` is how many rows the conditional EXPIRED update matches: 1 when this sweep is
 * the one that expires the booking, 0 when another sweep or a confirmation got there first.
 */
function makePrisma(staleBookings: Stale[], claimed = 1) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    booking: { updateMany: jest.fn().mockResolvedValue({ count: claimed }) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const rows = staleBookings.map((b) => ({
    seatBased: false,
    ...b,
    items: b.items.map((i) => ({ addOnId: null, ...i })),
    eventSessionId: 'session-1',
    holdExpiresAt: new Date(0),
  }));
  const prisma = {
    booking: { findMany: jest.fn().mockResolvedValue(rows) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, tx };
}

function makeService(prisma: unknown) {
  return new BookingsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    realInventory(),
    new AddOnInventoryService(),
    new MetricsService(),
    { observe: async () => undefined } as never,
    { observe: async () => undefined } as never,
  );
}

/** The SQL text of one `$executeRaw` tagged-template call. */
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

describe('BookingsService.releaseExpiredHolds', () => {
  it('returns 0 and does nothing when there are no stale holds', async () => {
    const { prisma } = makePrisma([]);
    const released = await makeService(prisma).releaseExpiredHolds();
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

    const released = await makeService(prisma).releaseExpiredHolds('session-1');
    expect(released).toBe(1);

    // One inventory-release statement per booking item.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    // Booking transitioned to EXPIRED — only if it is STILL awaiting payment and lapsed.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'b1',
        status: BookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { lt: expect.any(Date) },
      },
      data: expect.objectContaining({ status: BookingStatus.EXPIRED }),
    });
    // Outstanding payment marked failed.
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.FAILED } }),
    );
  });

  it('only queries PENDING_PAYMENT holds past their expiry', async () => {
    const { prisma } = makePrisma([]);
    await makeService(prisma).releaseExpiredHolds();
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(BookingStatus.PENDING_PAYMENT);
    expect(where.holdExpiresAt.lt).toBeInstanceOf(Date);
  });

  it('releases nothing for a booking another sweep, or a late webhook, reached first', async () => {
    /*
      The defect this pins. The candidates are read outside any transaction, and the worker
      and every create() on every replica sweep concurrently. Releasing unconditionally let
      two sweeps both decrement `quantityHeld` for one hold — stock sold twice — and let a
      booking CONFIRMED between the read and the release be overwritten to EXPIRED with its
      seats handed back. When the conditional claim matches nothing, nothing else may run.
    */
    const { prisma, tx } = makePrisma(
      [{ id: 'b1', items: [{ ticketTypeId: 't1', quantity: 2 }] }],
      0,
    );

    const released = await makeService(prisma).releaseExpiredHolds();

    expect(released).toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('claims the booking before it touches the stock', async () => {
    const { prisma, tx } = makePrisma([{ id: 'b1', items: [{ ticketTypeId: 't1', quantity: 1 }] }]);
    await makeService(prisma).releaseExpiredHolds();

    const claim = tx.booking.updateMany.mock.invocationCallOrder[0];
    const firstRelease = tx.$executeRaw.mock.invocationCallOrder[0];
    expect(claim).toBeLessThan(firstRelease);
  });

  it("returns a seated booking's seats, whatever kind of event it is", async () => {
    /*
      The strategy used to be chosen by experience type, so a seated CONCERT's abandoned
      checkout was released as general admission: the counter moved and its ShowSeat rows
      stayed HELD against a dead booking for ever. It follows the booking's own `seatBased`
      now, the same flag confirmation and refund read.
    */
    const { prisma, tx } = makePrisma([
      { id: 'b1', seatBased: true, items: [{ ticketTypeId: 't1', quantity: 2 }] },
    ]);
    await makeService(prisma).releaseExpiredHolds();

    expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain('"ShowSeat"');
  });

  it('releases a general-admission booking through the counters only', async () => {
    const { prisma, tx } = makePrisma([
      { id: 'b1', seatBased: false, items: [{ ticketTypeId: 't1', quantity: 2 }] },
    ]);
    await makeService(prisma).releaseExpiredHolds();

    expect(tx.$executeRaw.mock.calls.map(sqlOf).join('\n')).not.toContain('"ShowSeat"');
  });
});
