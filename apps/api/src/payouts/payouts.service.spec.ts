import { PayoutStatus, Role } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

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
