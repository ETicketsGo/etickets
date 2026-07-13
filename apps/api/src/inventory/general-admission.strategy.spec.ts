import { GeneralAdmissionInventoryStrategy } from './general-admission.strategy';
import { availableUnits } from './inventory-strategy.interface';
import { AppException } from '../common/errors';

describe('availableUnits', () => {
  it('is total minus sold minus held, floored at zero', () => {
    expect(availableUnits(100, 30, 10)).toBe(60);
    expect(availableUnits(10, 8, 5)).toBe(0); // never negative
  });
});

describe('GeneralAdmissionInventoryStrategy', () => {
  const strategy = new GeneralAdmissionInventoryStrategy();
  const ctx = {
    eventSessionId: 's1',
    bookingId: 'b1',
    holdExpiresAt: new Date(0),
    lines: [
      { ticketTypeId: 't1', quantity: 2 },
      { ticketTypeId: 't2', quantity: 1 },
    ],
  };

  it('reserve issues one conditional hold per line when stock is free', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await strategy.reserve(tx as never, ctx);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('reserve throws an oversell error when a line cannot be satisfied', async () => {
    // 0 rows affected → the conditional UPDATE guard rejected the hold.
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) };
    await expect(strategy.reserve(tx as never, ctx)).rejects.toBeInstanceOf(AppException);
    // Stops at the first unsatisfiable line.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('confirm moves held → sold and returns one ticket spec per unit', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const specs = await strategy.confirm(tx as never, ctx);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(specs).toHaveLength(3); // 2 + 1 units
    expect(specs.every((s) => s.seatId === undefined)).toBe(true);
  });

  it('release frees held stock, one statement per line', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await strategy.release(tx as never, ctx);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('refund decrements sold once per distinct ticket type, by the per-type count', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    // 3 refunded tickets: 2 of t1, 1 of t2 → 2 distinct types → 2 statements.
    await strategy.refund(tx as never, {
      eventSessionId: 's1',
      tickets: [{ ticketTypeId: 't1' }, { ticketTypeId: 't1' }, { ticketTypeId: 't2' }],
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('refund issues no statements when there are no tickets', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await strategy.refund(tx as never, { eventSessionId: 's1', tickets: [] });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('availability reports free units and defaults missing ticket types to 0', async () => {
    const client = {
      ticketInventory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ticketTypeId: 't1', quantityTotal: 50, quantitySold: 10, quantityHeld: 5 },
          ]),
      },
    };
    const map = await strategy.availability(client as never, ['t1', 't2']);
    expect(map.get('t1')).toBe(35);
    expect(map.get('t2')).toBe(0); // no inventory row → 0
  });
});
