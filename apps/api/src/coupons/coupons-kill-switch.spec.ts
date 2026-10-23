import { BookingsService } from '../bookings/bookings.service';
import { CouponsService } from './coupons.service';

/**
 * COUPONS_ENABLED=false: production keeps discount codes off until a capped code can be
 * reserved atomically (two checkouts can race past `maxRedemptions` today).
 *
 * Off means: no code is accepted at checkout, no public offer is listed, no code can be
 * created. On (the default, or the variable unset) everything works as before.
 */
const USER = { id: 'u-1', email: 'b@t.test', fullName: 'B', roles: [] } as never;
const config = (v?: string) => ({ get: (k: string) => (k === 'COUPONS_ENABLED' ? v : undefined) });

function bookings(couponsEnabled?: string) {
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'bk-1',
        organizationId: 'org-1',
        userId: 'u-1',
        status: 'PENDING_PAYMENT',
        subtotalMinor: 100_000,
        currency: 'INR',
        feeMode: 'CUSTOMER_PAYS',
        event: { feeMode: 'CUSTOMER_PAYS', venue: { country: 'India' }, organization: {} },
        payment: { status: 'REQUIRES_PAYMENT', providerRef: null },
      }),
    },
    coupon: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cp-1',
        organizationId: 'org-1',
        code: 'FIRST10',
        status: 'ACTIVE',
        type: 'PERCENT',
        value: 10,
        startsAt: null,
        endsAt: null,
        maxRedemptions: 5,
        redemptions: 0,
      }),
      findMany: jest.fn().mockResolvedValue([{ code: 'FIRST10', type: 'PERCENT', value: 10 }]),
    },
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({ event: { organizationId: 'org-1' } }),
    },
  };
  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  (service as unknown as { config: unknown }).config = config(couponsEnabled);
  return { service, prisma };
}

function coupons(couponsEnabled?: string) {
  const prisma = { coupon: { create: jest.fn().mockResolvedValue({ id: 'c1', code: 'SAVE10' }) } };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CouponsService(
    prisma as never,
    access as never,
    audit as never,
    config(couponsEnabled) as never,
  );
  return { service, prisma };
}

describe('COUPONS_ENABLED=false', () => {
  it('refuses a code at checkout with a plain reason and never reads the coupon', async () => {
    const { service, prisma } = bookings('false');
    await expect(service.applyCoupon(USER, 'bk-1', 'FIRST10')).rejects.toThrow(
      'Discount codes are not available right now.',
    );
    expect(prisma.coupon.findUnique).not.toHaveBeenCalled();
  });

  it('lists no public offers', async () => {
    const { service, prisma } = bookings('false');
    await expect(service.publicOffers('sess-1')).resolves.toEqual([]);
    expect(prisma.coupon.findMany).not.toHaveBeenCalled();
  });

  it('refuses to create a code', async () => {
    const { service, prisma } = coupons('false');
    await expect(
      service.create(USER, {
        organizationId: 'org-1',
        code: 'SAVE10',
        type: 'PERCENT',
        value: 10,
      } as never),
    ).rejects.toThrow('Discount codes are switched off on this platform for now.');
    expect(prisma.coupon.create).not.toHaveBeenCalled();
  });
});

describe('COUPONS_ENABLED unset or true (the default)', () => {
  it.each([undefined, 'true'])('still reads and lists codes when %p', async (value) => {
    const { service, prisma } = bookings(value);
    await service.publicOffers('sess-1');
    expect(prisma.coupon.findMany).toHaveBeenCalled();
  });

  it('still lets an organizer create a code', async () => {
    const { service, prisma } = coupons(undefined);
    await service
      .create(USER, {
        organizationId: 'org-1',
        code: 'SAVE10',
        type: 'PERCENT',
        value: 10,
      } as never)
      .catch(() => undefined);
    expect(prisma.coupon.create).toHaveBeenCalled();
  });
});
