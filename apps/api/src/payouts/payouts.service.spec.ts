import { PayoutStatus, Role } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const user = { id: 'u1', roles: [] } as never;

const paidRow = (currency: string, subtotal: number, organizerFee = 0) => ({
  currency,
  _sum: {
    subtotalMinor: subtotal,
    bookingFeeMinor: 100,
    paymentFeeMinor: 50,
    organizerFeeMinor: organizerFee,
  },
});

function makeService(
  overrides: Record<string, unknown> = {},
  paid: object[] = [paidRow('INR', 10_000)],
  refunds: object[] = [],
) {
  let created = 0;
  const prisma = {
    booking: { groupBy: jest.fn().mockResolvedValue(paid) },
    $queryRaw: jest.fn().mockResolvedValue(refunds),
    payout: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `p${++created}`,
        ...data,
      })),
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
      payout: { findMany: jest.fn().mockResolvedValue([{ id: 'open1', currency: 'INR' }]) },
    });
    await expect(service.generate(user, 'o1')).rejects.toBeInstanceOf(AppException);
  });

  it('generate creates a payout when no open payout exists', async () => {
    const { service, prisma } = makeService();
    await service.generate(user, 'o1');
    expect(prisma.payout.create).toHaveBeenCalled();
  });
});

/*
  Reported from QA: the dashboards added rupees, dollars and Canadian dollars into one figure.
  Payouts did the same at the source — every booking summed, whatever it was sold in, and the
  payout stored in the default currency. An organizer would have been paid rupees plus dollars
  as a number of rupees.
*/
describe('PayoutsService.generate — one payout per currency', () => {
  it('settles each currency on its own, in its own currency', async () => {
    const { service, prisma } = makeService(
      {},
      [paidRow('INR', 49_900, 1_000), paidRow('USD', 3_000, 100)],
      [{ currency: 'USD', amountMinor: BigInt(500) }],
    );
    const payouts = await service.generate(user, 'o1');
    expect(payouts).toHaveLength(2);
    const byCurrency = Object.fromEntries(
      prisma.payout.create.mock.calls.map(([{ data }]) => [data.currency, data]),
    );
    expect(byCurrency.INR).toMatchObject({ grossMinor: 49_900, refundMinor: 0, netMinor: 48_900 });
    expect(byCurrency.USD).toMatchObject({ grossMinor: 3_000, refundMinor: 500, netMinor: 2_400 });
  });

  it('still settles the dollars when the rupees already have an open payout', async () => {
    const { service, prisma } = makeService(
      { payout: { findMany: jest.fn().mockResolvedValue([{ id: 'open', currency: 'INR' }]) } },
      [paidRow('INR', 10_000), paidRow('USD', 2_000)],
    );
    const payouts = await service.generate(user, 'o1');
    expect(payouts.map((p) => p.currency)).toEqual(['USD']);
    expect(prisma.payout.create).toHaveBeenCalledTimes(1);
  });

  it('creates nothing when there is no paid revenue, rather than a zero payout', async () => {
    const { service, prisma } = makeService({}, [], []);
    await expect(service.generate(user, 'o1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });
});

/*
  A cash booking's money is already in the organizer's till, so paying it out pays them twice.
  And `subtotalMinor` is the price before any coupon: a half-price booking was settled at full.
*/
describe('PayoutsService.generate — only money the platform actually took', () => {
  const bookings = [
    {
      currency: 'INR',
      paymentMethod: 'ONLINE',
      subtotalMinor: 100_000,
      discountMinor: 50_000,
      bookingFeeMinor: 2_000,
      paymentFeeMinor: 0,
      organizerFeeMinor: 1_000,
    },
    {
      currency: 'INR',
      paymentMethod: 'CASH',
      subtotalMinor: 40_000,
      discountMinor: 0,
      bookingFeeMinor: 0,
      paymentFeeMinor: 0,
      organizerFeeMinor: 0,
    },
  ];
  /** A groupBy over the rows above that honours the filter it is given. */
  const groupBy = jest.fn(
    async ({ where, _sum }: { where: { paymentMethod?: string }; _sum: Record<string, true> }) => {
      const rows = bookings.filter(
        (b) => !where.paymentMethod || b.paymentMethod === where.paymentMethod,
      );
      const byCurrency = new Map<string, Record<string, number>>();
      for (const row of rows) {
        const sums = byCurrency.get(row.currency) ?? {};
        for (const key of Object.keys(_sum)) {
          sums[key] = (sums[key] ?? 0) + (row as unknown as Record<string, number>)[key];
        }
        byCurrency.set(row.currency, sums);
      }
      return [...byCurrency].map(([currency, sums]) => ({ currency, _sum: sums }));
    },
  );

  it('settles online bookings at what the customer paid for the tickets', async () => {
    const { service, prisma } = makeService();
    prisma.booking.groupBy = groupBy;
    await service.generate(user, 'o1');
    expect(prisma.payout.create.mock.calls[0][0].data).toMatchObject({
      currency: 'INR',
      grossMinor: 100_000,
      // 100 000 − 50 000 coupon − 1 000 organizer fee; the 40 000 in cash is not the platform's.
      netMinor: 49_000,
    });
  });

  it('refuses a check-in staff member, who may not read or raise payouts', async () => {
    groupBy.mockClear();
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.CHECKIN_STAFF,
    });
    Object.assign(prisma, {
      booking: { groupBy },
      $queryRaw: jest.fn().mockResolvedValue([]),
    });
    await expect(service.generate(asUser(), 'org-1')).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('PayoutsService (markPaid)', () => {
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

// ---------------------------------------------------------------------------
// listForOrg financial-read RBAC (D8) — real OrgAccessService, mocked Prisma.
// ---------------------------------------------------------------------------

const asUser = (globalRoles: string[] = []): RequestUser => ({
  id: 'u1',
  email: 'u1@example.test',
  fullName: 'User One',
  roles: globalRoles as never,
});

function makeServiceWithAccess(membership: { status: string; role: string } | null) {
  const prisma = {
    organizationMember: { findUnique: jest.fn().mockResolvedValue(membership) },
    payout: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const access = new OrgAccessService(prisma as never);
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    service: new PayoutsService(prisma as never, access, audit as never),
  };
}

describe('PayoutsService.listForOrg financial-read gating', () => {
  it('FORBIDS an active CHECKIN_STAFF member', async () => {
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.CHECKIN_STAFF,
    });
    await expect(service.listForOrg(asUser(), 'org-1')).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
  });

  it('allows ORGANIZER_OWNER', async () => {
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.ORGANIZER_OWNER,
    });
    await expect(service.listForOrg(asUser(), 'org-1')).resolves.toEqual([]);
    expect(prisma.payout.findMany).toHaveBeenCalled();
  });

  it('allows ORGANIZER_MANAGER', async () => {
    const { service, prisma } = makeServiceWithAccess({
      status: 'ACTIVE',
      role: Role.ORGANIZER_MANAGER,
    });
    await expect(service.listForOrg(asUser(), 'org-1')).resolves.toEqual([]);
    expect(prisma.payout.findMany).toHaveBeenCalled();
  });

  it('allows a platform admin (no membership needed)', async () => {
    const { service, prisma } = makeServiceWithAccess(null);
    await expect(service.listForOrg(asUser([Role.ADMIN]), 'org-1')).resolves.toEqual([]);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.payout.findMany).toHaveBeenCalled();
  });
});
