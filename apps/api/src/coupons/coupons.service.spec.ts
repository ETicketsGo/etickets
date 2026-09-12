import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import { createCouponSchema } from '@eticketsgo/validation';
import { CouponsService } from './coupons.service';
import type { RequestUser } from '../common/decorators';

const user: RequestUser = {
  id: 'u1',
  email: 'o@x.test',
  fullName: 'Owner',
  roles: [Role.ORGANIZER_OWNER],
};

function makeService(
  overrides: { coupon?: Record<string, unknown>; venues?: { country: string }[] } = {},
) {
  const coupon = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({ id: 'c1', code: 'SAVE10', type: 'PERCENT', value: 10 }),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({ id: 'c1' }),
    delete: jest.fn().mockResolvedValue({ id: 'c1' }),
    ...(overrides.coupon ?? {}),
  };
  const venue = { findMany: jest.fn().mockResolvedValue(overrides.venues ?? []) };
  const prisma = { coupon, venue };
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

/*
  A FIXED coupon's value is minor units, and nothing said minor units of what: a ₹500-off code
  took $500 off a US booking. Every FIXED coupon now carries the currency it applies in.
*/
describe('CouponsService — the currency of a fixed amount', () => {
  const fixed = { ...baseInput, code: 'FLAT500', type: 'FIXED' as const, value: 50_000 };
  const storedCurrency = (coupon: { create: jest.Mock }) =>
    coupon.create.mock.calls[0][0].data.currency;

  it('stores no currency on a PERCENT coupon, even when one is sent', async () => {
    const { service, coupon } = makeService({ venues: [{ country: 'India' }] });
    await service.create(user, { ...baseInput, currency: 'USD' });
    expect(storedCurrency(coupon)).toBeNull();
  });

  it('defaults a FIXED coupon to the currency most of the organization’s venues sell in', async () => {
    const { service, coupon } = makeService({
      venues: [{ country: 'USA' }, { country: 'United States' }, { country: 'India' }],
    });
    await service.create(user, fixed);
    expect(storedCurrency(coupon)).toBe('USD');
  });

  it('defaults a FIXED coupon to INR before the organization has a venue', async () => {
    const { service, coupon } = makeService({ venues: [] });
    await service.create(user, fixed);
    expect(storedCurrency(coupon)).toBe('INR');
  });

  it('keeps a FIXED coupon in a currency the organization sells in', async () => {
    const { service, coupon } = makeService({
      venues: [{ country: 'India' }, { country: 'Canada' }],
    });
    await service.create(user, { ...fixed, currency: 'CAD' });
    expect(storedCurrency(coupon)).toBe('CAD');
  });

  it('refuses a FIXED coupon in a currency none of its venues sells in, which could never apply', async () => {
    const { service, coupon } = makeService({ venues: [{ country: 'India' }] });
    await expect(service.create(user, { ...fixed, currency: 'USD' })).rejects.toMatchObject({
      status: 400,
    });
    expect(coupon.create).not.toHaveBeenCalled();
  });

  it('gives a FIXED coupon from before currencies its organization’s own on its next update', async () => {
    const { service, coupon } = makeService({
      venues: [{ country: 'Canada' }],
      coupon: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          organizationId: 'org1',
          type: 'FIXED',
          currency: null,
          redemptions: 0,
        }),
      },
    });
    await service.update(user, 'c1', { value: 1_000 });
    expect(coupon.update.mock.calls[0][0].data.currency).toBe('CAD');
  });

  it('leaves a PERCENT coupon without a currency on update', async () => {
    const { service, coupon } = makeService({
      venues: [{ country: 'India' }],
      coupon: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          organizationId: 'org1',
          type: 'PERCENT',
          currency: null,
          redemptions: 0,
        }),
      },
    });
    await service.update(user, 'c1', { value: 15, currency: 'INR' });
    expect(coupon.update.mock.calls[0][0].data.currency).toBeUndefined();
  });

  it('accepts a currency code in any case and stores it upper-cased', () => {
    expect(createCouponSchema.parse({ ...fixed, currency: ' usd ' }).currency).toBe('USD');
    expect(createCouponSchema.safeParse({ ...fixed, currency: 'rupees' }).success).toBe(false);
  });
});
