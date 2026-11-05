import { OrganizationStatus } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { PayoutAccountsService } from './payout-accounts.service';
import { SUSPENDED_BANK_MESSAGE, SUSPENDED_PAYOUT_MESSAGE } from './organization-money-gate';

/**
 * A suspended organizer can read its money and cannot move it or redirect it.
 *
 * Suspension used to stop new sales and nothing else: the organizer could still raise a payout
 * of what it had taken, and replace the bank account the payout would land in. Both writes are
 * refused here, before anything is written, with a sentence a person can act on; both reads
 * still answer.
 */
const owner = { id: 'u-owner', email: 'o@t.test', fullName: 'O', roles: [] } as never;
const KEY = Buffer.alloc(32, 7).toString('base64');

const settings = {
  effectiveFor: async () => ({
    holdDays: 0,
    minPayoutMinor: {},
    source: { holdDays: 'platform', minPayoutMinor: 'platform' },
  }),
} as never;

function payoutsFor(status: string) {
  const writes: string[] = [];
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue({ status }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    settlement: { findMany: jest.fn().mockResolvedValue([]) },
    event: { findMany: jest.fn().mockResolvedValue([]) },
    booking: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'bk1',
          eventId: 'e1',
          currency: 'INR',
          subtotalMinor: 10_000,
          discountMinor: 0,
          bookingFeeMinor: 100,
          paymentFeeMinor: 50,
          organizerFeeMinor: 0,
        },
      ]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    refund: { findMany: jest.fn().mockResolvedValue([]) },
    payoutAllocation: {
      createMany: jest.fn(async () => {
        writes.push('allocation');
        return { count: 1 };
      }),
    },
    payout: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: object }) => {
        writes.push('payout');
        return { id: 'p1', ...data };
      }),
    },
  } as Record<string, unknown>;
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  return {
    writes,
    audit,
    service: new PayoutsService(prisma as never, access as never, audit as never, settings),
  };
}

describe('a suspended organizer cannot raise a payout', () => {
  it('refuses the organizer, in plain words, and writes nothing', async () => {
    const { service, writes, audit } = payoutsFor(OrganizationStatus.SUSPENDED);
    await expect(service.generate(owner, 'org-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: SUSPENDED_PAYOUT_MESSAGE,
    });
    expect(writes).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('holds the automatic settlement run as well', async () => {
    const { service, writes } = payoutsFor(OrganizationStatus.SUSPENDED);
    await expect(
      service.generateAutomatically('org-1', new Date('2026-11-01T00:00:00Z')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(writes).toEqual([]);
  });

  it('still raises the same payout for an approved organizer (the control)', async () => {
    const { service, writes } = payoutsFor(OrganizationStatus.APPROVED);
    const created = await service.generate(owner, 'org-1');
    expect(created).toHaveLength(1);
    expect(writes).toContain('payout');
  });

  it('does not hold a PENDING organizer, which has nothing to pay and may be onboarding', async () => {
    const { service } = payoutsFor(OrganizationStatus.PENDING);
    await expect(service.generate(owner, 'org-1')).resolves.toHaveLength(1);
  });

  it('still lets the suspended organizer read its payouts', async () => {
    const { service } = payoutsFor(OrganizationStatus.SUSPENDED);
    await expect(service.listForOrg(owner, 'org-1')).resolves.toEqual([]);
  });
});

function accountsFor(status: string) {
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue({ status }) },
    organizerPayoutAccount: { findMany: jest.fn().mockResolvedValue([]) },
    // Reaching the write transaction is the failure this file is about.
    $transaction: jest.fn(async () => {
      throw new Error('a suspended organizer reached the bank-account write');
    }),
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const audience = { notifyOrganizationOwners: jest.fn() };
  return {
    prisma,
    audience,
    service: new PayoutAccountsService(
      prisma as never,
      access as never,
      audit as never,
      { get: () => KEY } as never,
      audience as never,
    ),
  };
}

const DETAILS = {
  currency: 'INR',
  holderName: 'Bengaluru Live Pvt Ltd',
  bankName: 'HDFC Bank',
  bankCode: 'HDFC0001234',
  accountNumber: '501001234567',
};

describe('a suspended organizer cannot change its bank details', () => {
  it('refuses the save, in plain words, before the write and before any email', async () => {
    const { service, prisma, audience } = accountsFor(OrganizationStatus.SUSPENDED);
    await expect(service.save(owner, 'org-1', DETAILS)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: SUSPENDED_BANK_MESSAGE,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audience.notifyOrganizationOwners).not.toHaveBeenCalled();
  });

  it('reaches the write for an approved organizer (the control)', async () => {
    const { service, prisma } = accountsFor(OrganizationStatus.APPROVED);
    await expect(service.save(owner, 'org-1', DETAILS)).rejects.toThrow(/reached the bank-account/);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('still lets the suspended organizer read what is on file', async () => {
    const { service } = accountsFor(OrganizationStatus.SUSPENDED);
    await expect(service.listForOrg(owner, 'org-1')).resolves.toEqual([]);
  });
});
