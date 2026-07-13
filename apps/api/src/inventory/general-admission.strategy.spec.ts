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
  const lines = [
    { ticketTypeId: 't1', quantity: 2 },
    { ticketTypeId: 't2', quantity: 1 },
  ];

  it('reserve issues one conditional hold per line when stock is free', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await strategy.reserve(tx as never, lines);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('reserve throws an oversell error when a line cannot be satisfied', async () => {
    // 0 rows affected → the conditional UPDATE guard rejected the hold.
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) };
    await expect(strategy.reserve(tx as never, lines)).rejects.toBeInstanceOf(AppException);
    // Stops at the first unsatisfiable line.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('confirm moves held → sold, one statement per line', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await strategy.confirm(tx as never, lines);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('release frees held stock, one statement per line', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await strategy.release(tx as never, lines);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('availability reports free units and defaults missing ticket types to 0', async () => {
    const client = {
      ticketInventory: {
        findMany: jest.fn().mockResolvedValue([
          { ticketTypeId: 't1', quantityTotal: 50, quantitySold: 10, quantityHeld: 5 },
        ]),
      },
    };
    const map = await strategy.availability(client as never, ['t1', 't2']);
    expect(map.get('t1')).toBe(35);
    expect(map.get('t2')).toBe(0); // no inventory row → 0
  });
});
