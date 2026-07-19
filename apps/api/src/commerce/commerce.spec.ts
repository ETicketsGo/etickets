import { AddOnInventoryService } from './addon-inventory.service';
import { onSale, toPublicAddOn } from './addons.service';
import { AppException } from '../common/errors';

function txWith(affected: number) {
  return { $executeRaw: jest.fn().mockResolvedValue(affected) } as never;
}

describe('AddOnInventoryService.reserve', () => {
  const svc = new AddOnInventoryService();

  it('holds stock when the conditional update affects one row', async () => {
    const tx = txWith(1);
    await expect(svc.reserve(tx, [{ addOnId: 'a1', quantity: 2 }])).resolves.toBeUndefined();
    expect((tx as never as { $executeRaw: jest.Mock }).$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('throws when there is not enough stock (zero rows affected)', async () => {
    const tx = txWith(0);
    await expect(svc.reserve(tx, [{ addOnId: 'a1', quantity: 999 }])).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('confirm/release/refund each issue one statement per line', async () => {
    const lines = [
      { addOnId: 'a1', quantity: 1 },
      { addOnId: 'a2', quantity: 3 },
    ];
    for (const op of ['confirm', 'release', 'refund'] as const) {
      const tx = txWith(1);
      await svc[op](tx, lines);
      expect((tx as never as { $executeRaw: jest.Mock }).$executeRaw).toHaveBeenCalledTimes(2);
    }
  });
});

describe('onSale', () => {
  const now = new Date('2026-07-19T12:00:00Z');
  it('is true within (or without) a window', () => {
    expect(onSale(null, null, now)).toBe(true);
    expect(onSale(new Date('2026-07-18'), new Date('2026-07-20'), now)).toBe(true);
  });
  it('is false before start or after end', () => {
    expect(onSale(new Date('2026-07-20'), null, now)).toBe(false);
    expect(onSale(null, new Date('2026-07-18'), now)).toBe(false);
  });
});

describe('toPublicAddOn', () => {
  const base = {
    id: 'a1',
    type: 'MERCHANDISE',
    name: 'Tee',
    description: null,
    priceMinor: 2000,
    currency: 'INR',
    imageUrl: null,
    maxPerOrder: 10,
  };

  it('reports unlimited stock as null remaining', () => {
    const r = toPublicAddOn({
      ...base,
      inventory: { quantityTotal: null, quantitySold: 5, quantityHeld: 0 },
    });
    expect(r.remaining).toBeNull();
    expect(r.soldOut).toBe(false);
  });

  it('computes remaining and sold-out for limited stock', () => {
    const r = toPublicAddOn({
      ...base,
      inventory: { quantityTotal: 10, quantitySold: 7, quantityHeld: 3 },
    });
    expect(r.remaining).toBe(0);
    expect(r.soldOut).toBe(true);
  });
});
