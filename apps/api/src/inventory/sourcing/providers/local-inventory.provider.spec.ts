import { ExperienceType } from '@eticketsgo/shared-types';
import { AppException } from '../../../common/errors';
import { InventoryService } from '../../inventory.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { DirectInventoryProvider } from './direct.provider';
import { ManualInventoryProvider } from './manual.provider';
import type { InventoryStrategy } from '../../inventory-strategy.interface';

const TX = { marker: 'tx' } as unknown as Parameters<InventoryStrategy['reserve']>[0];

function setup() {
  const strategy = {
    reserve: jest.fn().mockResolvedValue(undefined),
    confirm: jest.fn().mockResolvedValue([{ ticketTypeId: 'tt1' }]),
    release: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
    availability: jest.fn().mockResolvedValue(new Map([['tt1', 7]])),
  } as unknown as InventoryStrategy;
  const inventory = {
    forExperienceType: jest.fn().mockReturnValue(strategy),
  } as unknown as InventoryService;
  const prisma = {
    // interactive $transaction: invoke the callback with our fake tx
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(TX)),
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
  } as unknown as PrismaService;
  const provider = new DirectInventoryProvider(inventory, prisma);
  return { provider, strategy, inventory, prisma };
}

const base = {
  experienceType: ExperienceType.MOVIE,
  eventSessionId: 'sess_1',
  bookingId: 'bk_1',
  lines: [{ ticketTypeId: 'tt1', quantity: 2 }],
};

describe('LocalInventoryProvider (via DirectInventoryProvider)', () => {
  it('advertises LOCAL, no-search, no-failover capabilities', () => {
    const { provider } = setup();
    expect(provider.capabilities).toEqual({ search: false, authority: 'LOCAL', failover: false });
    expect(provider.name).toBe('direct');
    expect(provider.sourceKind).toBe('DIRECT');
  });

  it('availability delegates to the strategy and maps units', async () => {
    const { provider, strategy } = setup();
    const snap = await provider.availability({
      experienceType: ExperienceType.MOVIE,
      eventSessionId: 'sess_1',
      ticketTypeIds: ['tt1'],
    });
    expect(strategy.availability).toHaveBeenCalled();
    expect(snap.unitsByTicketType).toEqual({ tt1: 7 });
    expect(snap.authority).toBe('LOCAL');
  });

  it('lockInventory composes into a caller-provided tx (no new transaction)', async () => {
    const { provider, strategy, prisma } = setup();
    const res = await provider.lockInventory({
      ...base,
      holdExpiresAt: new Date('2026-07-26T00:10:00Z'),
      tx: TX,
    });
    expect(strategy.reserve).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ bookingId: 'bk_1' }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res).toMatchObject({ lockRef: 'bk_1', authority: 'LOCAL' });
  });

  it('lockInventory opens its own transaction when no tx is supplied', async () => {
    const { provider, strategy, prisma } = setup();
    await provider.lockInventory({ ...base, holdExpiresAt: new Date() });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(strategy.reserve).toHaveBeenCalledWith(TX, expect.anything());
  });

  it('confirmBooking returns the strategy ticket specs', async () => {
    const { provider, strategy } = setup();
    const res = await provider.confirmBooking({ ...base, tx: TX });
    expect(strategy.confirm).toHaveBeenCalled();
    expect(res).toEqual({ confirmationRef: 'bk_1', tickets: [{ ticketTypeId: 'tt1' }] });
  });

  it('cancelBooking releases the hold', async () => {
    const { provider, strategy } = setup();
    await provider.cancelBooking({ ...base, tx: TX });
    expect(strategy.release).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ bookingId: 'bk_1' }),
    );
  });

  it('refund returns tickets to stock via the strategy', async () => {
    const { provider, strategy } = setup();
    await provider.refund({
      experienceType: ExperienceType.MOVIE,
      eventSessionId: 'sess_1',
      bookingId: 'bk_1',
      tickets: [{ ticketTypeId: 'tt1', seatId: null }],
      tx: TX,
    });
    expect(strategy.refund).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ eventSessionId: 'sess_1' }),
    );
  });

  it('search refuses honestly (discovery owns local search)', async () => {
    const { provider } = setup();
    await expect(provider.search({})).rejects.toBeInstanceOf(AppException);
  });

  it('sync is a no-op for authoritative LOCAL stock', async () => {
    const { provider } = setup();
    expect(await provider.sync({})).toEqual({ itemsReconciled: 0, authority: 'LOCAL' });
  });

  it('health is true when the database round-trip succeeds', async () => {
    const { provider } = setup();
    expect((await provider.health()).healthy).toBe(true);
  });

  it('health is false (never throws) when the database is unreachable', async () => {
    const { provider, prisma } = setup();
    (prisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const health = await provider.health();
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe('database_unreachable');
  });

  it('ManualInventoryProvider shares behaviour but reports MANUAL provenance', () => {
    const strategy = {} as InventoryStrategy;
    const inventory = { forExperienceType: () => strategy } as unknown as InventoryService;
    const prisma = {} as PrismaService;
    const manual = new ManualInventoryProvider(inventory, prisma);
    expect(manual.name).toBe('manual');
    expect(manual.sourceKind).toBe('MANUAL');
    expect(manual.capabilities.authority).toBe('LOCAL');
  });
});
