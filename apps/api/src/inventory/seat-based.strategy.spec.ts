import { SeatBasedInventoryStrategy } from './seat-based.strategy';
import { AppException } from '../common/errors';

const ctx = (seatIds: string[]) => ({
  eventSessionId: 'sess-1',
  bookingId: 'book-1',
  holdExpiresAt: new Date(0),
  lines: [{ ticketTypeId: 'tt-1', quantity: seatIds.length, seatIds }],
});

describe('SeatBasedInventoryStrategy', () => {
  const strategy = new SeatBasedInventoryStrategy();

  it('reserve holds exactly the selected seats when all are available', async () => {
    // First $executeRaw is the atomic seat lock; it must affect all requested seats.
    const tx = {
      $executeRaw: jest
        .fn()
        .mockResolvedValueOnce(2) // seat lock: 2 of 2 flipped
        .mockResolvedValue(1), // inventory counter bump
    };
    await expect(strategy.reserve(tx as never, ctx(['s1', 's2']))).resolves.toBeUndefined();
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it('reserve throws (double-book protection) when a seat is already taken', async () => {
    // Only 1 of the 2 requested seats was AVAILABLE → conflict, whole tx rolls back.
    const tx = { $executeRaw: jest.fn().mockResolvedValueOnce(1) };
    await expect(strategy.reserve(tx as never, ctx(['s1', 's2']))).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('reserve rejects an empty seat selection', async () => {
    const tx = { $executeRaw: jest.fn() };
    await expect(strategy.reserve(tx as never, ctx([]))).rejects.toBeInstanceOf(AppException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('confirm marks held seats sold and issues one seat-bound ticket each', async () => {
    const tx = {
      showSeat: {
        findMany: jest.fn().mockResolvedValue([
          { seatId: 's1', seat: { label: '1', seatCategoryId: 'cat-1', row: { label: 'A' } } },
          { seatId: 's2', seat: { label: '2', seatCategoryId: 'cat-1', row: { label: 'A' } } },
        ]),
      },
      ticketType: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tt-1', seatCategoryId: 'cat-1' }]),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const specs = await strategy.confirm(tx as never, ctx(['s1', 's2']));
    expect(specs).toEqual([
      { ticketTypeId: 'tt-1', seatId: 's1', seatLabel: 'A1' },
      { ticketTypeId: 'tt-1', seatId: 's2', seatLabel: 'A2' },
    ]);
  });

  it('confirm is a no-op when the booking holds no seats', async () => {
    const tx = {
      showSeat: { findMany: jest.fn().mockResolvedValue([]) },
      ticketType: { findMany: jest.fn() },
      $executeRaw: jest.fn(),
    };
    const specs = await strategy.confirm(tx as never, ctx(['s1']));
    expect(specs).toEqual([]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  /** Joins a tagged-template call's SQL fragments so we can assert on its text. */
  const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');
  const seatUpdateCalls = (fn: jest.Mock) =>
    fn.mock.calls.filter((c) => sqlOf(c).includes('"ShowSeat"'));

  it('refund returns seats to AVAILABLE and decrements sold per type', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    // 2 seated tickets of one type → one ShowSeat UPDATE + one counter decrement.
    await strategy.refund(tx as never, {
      eventSessionId: 'sess-1',
      tickets: [
        { ticketTypeId: 'tt-1', seatId: 's1' },
        { ticketTypeId: 'tt-1', seatId: 's2' },
      ],
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    // The seat UPDATE (ShowSeat → AVAILABLE) ran exactly once.
    const seatCalls = seatUpdateCalls(tx.$executeRaw);
    expect(seatCalls).toHaveLength(1);
    expect(sqlOf(seatCalls[0])).toContain("'AVAILABLE'");
  });

  it('refund skips the seat UPDATE when no seatIds are present', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    // Two distinct types, no seats → two counter decrements, zero seat updates.
    await strategy.refund(tx as never, {
      eventSessionId: 'sess-1',
      tickets: [
        { ticketTypeId: 'tt-1', seatId: null },
        { ticketTypeId: 'tt-2', seatId: null },
      ],
    });
    expect(seatUpdateCalls(tx.$executeRaw)).toHaveLength(0);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2); // per-type decrements only
  });
});
