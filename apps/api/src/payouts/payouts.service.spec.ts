import { PayoutStatus } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { AppException } from '../common/errors';

const user = { id: 'u1', roles: [] } as never;

function makeService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    booking: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    refund: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    payout: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'p1', netMinor: 0 }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'p1', status: PayoutStatus.PENDING, organizationId: 'o1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      ...(overrides.payout as object),
    },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    service: new PayoutsService(prisma as never, access as never, audit as never),
  };
}

describe('PayoutsService (double-payout guards)', () => {
  it('generate refuses when an open payout already exists for the scope', async () => {
    const { service } = makeService({
      payout: { findFirst: jest.fn().mockResolvedValue({ id: 'open1' }) },
    });
    await expect(service.generate(user, 'o1')).rejects.toBeInstanceOf(AppException);
  });

  it('generate creates a payout when no open payout exists', async () => {
    const { service, prisma } = makeService();
    await service.generate(user, 'o1');
    expect(prisma.payout.create).toHaveBeenCalled();
  });

  it('markPaid is idempotent: a second finalize is rejected (claim count 0)', async () => {
    const { service } = makeService({
      payout: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'p1', status: PayoutStatus.PAID, organizationId: 'o1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });
    await expect(service.markPaid(user, 'p1')).rejects.toBeInstanceOf(AppException);
  });

  it('markPaid finalizes an open payout exactly once', async () => {
    const { service, prisma } = makeService();
    await service.markPaid(user, 'p1');
    expect(prisma.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PayoutStatus.PAID }) }),
    );
  });
});
