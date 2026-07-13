import { Role } from '@eticketsgo/shared-types';
import { ReportsService } from './reports.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * organizerEventReport exposes revenue/fees/refunds (financial data). D8 gates
 * it to org owners/managers + platform admins. Real OrgAccessService, mocked
 * Prisma; the aggregate calls are stubbed so the allowed path runs end-to-end.
 */
const asUser = (globalRoles: string[] = []): RequestUser => ({
  id: 'u1',
  email: 'u1@example.test',
  fullName: 'User One',
  roles: globalRoles as never,
});

function makeService(membership: { status: string; role: string } | null) {
  const prisma = {
    event: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: 'ev-1',
          organizationId: 'org-1',
          title: 'Show',
          status: 'PUBLISHED',
        }),
    },
    organizationMember: { findUnique: jest.fn().mockResolvedValue(membership) },
    booking: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    refund: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    ticket: { count: jest.fn().mockResolvedValue(0) },
    ticketInventory: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    bookingItem: { groupBy: jest.fn().mockResolvedValue([]) },
    ticketType: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const access = new OrgAccessService(prisma as never);
  return { prisma, service: new ReportsService(prisma as never, access) };
}

describe('ReportsService.organizerEventReport financial-read gating', () => {
  it('FORBIDS an active CHECKIN_STAFF member', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE', role: Role.CHECKIN_STAFF });
    await expect(service.organizerEventReport(asUser(), 'ev-1')).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
    // Rejected before any money is aggregated.
    expect(prisma.booking.aggregate).not.toHaveBeenCalled();
  });

  it('allows ORGANIZER_OWNER and returns the report', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE', role: Role.ORGANIZER_OWNER });
    const report = await service.organizerEventReport(asUser(), 'ev-1');
    expect(report).toMatchObject({ event: { id: 'ev-1' } });
    expect(prisma.booking.aggregate).toHaveBeenCalled();
  });

  it('allows ORGANIZER_MANAGER', async () => {
    const { service } = makeService({ status: 'ACTIVE', role: Role.ORGANIZER_MANAGER });
    await expect(service.organizerEventReport(asUser(), 'ev-1')).resolves.toMatchObject({
      event: { id: 'ev-1' },
    });
  });

  it('allows a platform admin (no membership needed)', async () => {
    const { service, prisma } = makeService(null);
    await expect(service.organizerEventReport(asUser([Role.ADMIN]), 'ev-1')).resolves.toMatchObject(
      { event: { id: 'ev-1' } },
    );
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for a missing event (no authz check)', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE', role: Role.CHECKIN_STAFF });
    prisma.event.findUnique.mockResolvedValueOnce(null);
    await expect(service.organizerEventReport(asUser(), 'missing')).resolves.toBeNull();
  });
});
