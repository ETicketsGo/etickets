import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

/** COMBINED bands on the admin write path: what is stored, and what is refused. */
describe('AdminService COMBINED fee bands', () => {
  function make(existing: unknown = null) {
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'n', ...data }));
    const update = jest.fn().mockImplementation(({ data }) => ({ id: 'r', ...data }));
    const prisma = {
      feeRule: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(existing),
        create,
        update,
      },
    } as unknown as PrismaService;
    const audit = { record: jest.fn() } as unknown as AuditService;
    return { svc: new AdminService(prisma, audit), create, update };
  }
  const BASE = { currency: 'INR', minMinor: 100_000, maxMinor: null, country: 'India' };

  // Owner decision 2026-10-29: a combined band may have an optional minimum and maximum.
  it('stores the percentage, the per-ticket amount and the optional limits', async () => {
    const { svc, create } = make();
    await svc.createFeeRule('a', {
      ...BASE,
      feeType: 'COMBINED',
      feePercentBps: 300,
      feeMinor: 500,
      minFeeMinor: 100,
      maxFeeMinor: 900,
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      feeType: 'COMBINED',
      feePercentBps: 300,
      feeMinor: 500,
      minFeeMinor: 100,
      maxFeeMinor: 900,
    });
  });

  it('stores no limits when none are given (the default)', async () => {
    const { svc, create } = make();
    await svc.createFeeRule('a', {
      ...BASE,
      feeType: 'COMBINED',
      feePercentBps: 300,
      feeMinor: 500,
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ minFeeMinor: null, maxFeeMinor: null });
  });

  it('refuses a minimum above the maximum', async () => {
    const { svc } = make();
    await expect(
      svc.createFeeRule('a', {
        ...BASE,
        feeType: 'COMBINED',
        feePercentBps: 300,
        feeMinor: 500,
        minFeeMinor: 900,
        maxFeeMinor: 100,
      }),
    ).rejects.toThrow(/minimum fee cannot be more than the maximum/);
  });

  it('refuses a combined band with no percentage', async () => {
    const { svc } = make();
    await expect(
      svc.createFeeRule('a', { ...BASE, feeType: 'COMBINED', feeMinor: 500 }),
    ).rejects.toThrow(/combined band needs a percentage/);
  });

  it('refuses a combined band with no per-ticket amount', async () => {
    const { svc } = make();
    await expect(
      svc.createFeeRule('a', { ...BASE, feeType: 'COMBINED', feePercentBps: 300, feeMinor: 0 }),
    ).rejects.toThrow(/fixed amount per ticket/);
  });

  it('switching a combined band back to a percentage clears the fixed part', async () => {
    const { svc, update } = make({
      id: 'r',
      label: 'x',
      ...BASE,
      feeType: 'COMBINED',
      feePercentBps: 300,
      feeMinor: 500,
      minFeeMinor: null,
      maxFeeMinor: null,
      region: '*',
      active: true,
      deletedAt: null,
    });
    await svc.updateFeeRule('a', 'r', { feeType: 'PERCENT' });
    expect(update.mock.calls[0][0].data).toMatchObject({
      feeType: 'PERCENT',
      feeMinor: 0,
      feePercentBps: 300,
    });
  });
});
