import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import { CouponsService } from './coupons.service';
import type { RequestUser } from '../common/decorators';

const user: RequestUser = {
  id: 'u1',
  email: 'o@x.test',
  fullName: 'Owner',
  roles: [Role.ORGANIZER_OWNER],
};

function makeService(overrides: { coupon?: Record<string, unknown> } = {}) {
  const coupon = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({ id: 'c1', code: 'SAVE10', type: 'PERCENT', value: 10 }),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({ id: 'c1' }),
    delete: jest.fn().mockResolvedValue({ id: 'c1' }),
    ...(overrides.coupon ?? {}),
  };
  const prisma = { coupon };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CouponsService(prisma as never, access as never, audit as never);
  return { service, coupon, access, audit };
}

const baseInput = {
  organizationId: 'org1',
  code: 'SAVE10',
  type: 'PERCENT' as const,
  value: 10,
};

describe('CouponsService', () => {
  it('creates a coupon (org-scoped, audited)', async () => {
    const { service, coupon, access, audit } = makeService();
    await service.create(user, baseInput);
    expect(access.assertMember).toHaveBeenCalledWith(user, 'org1', expect.any(Array));
    expect(coupon.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COUPON_CREATED', entityType: 'Coupon' }),
    );
  });

  it('maps a duplicate-code error to CONFLICT', async () => {
    const { service } = makeService({
      coupon: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'x',
          }),
        ),
      },
    });
    await expect(service.create(user, baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to delete a redeemed coupon (financial record)', async () => {
    const { service, coupon } = makeService({
      coupon: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'c1', organizationId: 'org1', redemptions: 3 }),
      },
    });
    await expect(service.remove(user, 'c1')).rejects.toMatchObject({ status: 409 });
    expect(coupon.delete).not.toHaveBeenCalled();
  });

  it('deletes an unredeemed coupon', async () => {
    const { service, coupon } = makeService({
      coupon: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'c1', organizationId: 'org1', redemptions: 0 }),
      },
    });
    await service.remove(user, 'c1');
    expect(coupon.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });

  it('404s when the coupon does not exist', async () => {
    const { service } = makeService({ coupon: { findUnique: jest.fn().mockResolvedValue(null) } });
    await expect(service.update(user, 'nope', { status: 'INACTIVE' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
