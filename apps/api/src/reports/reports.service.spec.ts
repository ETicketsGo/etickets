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

function makeService(
  membership: { status: string; role: string } | null,
  eventExtra: Record<string, unknown> = {},
) {
  const prisma = {
    event: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'ev-1',
        organizationId: 'org-1',
        title: 'Show',
        status: 'PUBLISHED',
        venue: null,
        sessions: [],
        ...eventExtra,
      }),
    },
    organizationMember: { findUnique: jest.fn().mockResolvedValue(membership) },
    booking: {
      aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    refund: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    ticket: { count: jest.fn().mockResolvedValue(0) },
    ticketInventory: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    bookingItem: { groupBy: jest.fn().mockResolvedValue([]) },
    ticketType: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ currency: 'USD' }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const access = new OrgAccessService(prisma as never, { record: async () => undefined } as never);
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

  it("carries the event's selling currency, so its totals are not formatted as rupees", async () => {
    const { service } = makeService({ status: 'ACTIVE', role: Role.ORGANIZER_OWNER });
    await expect(service.organizerEventReport(asUser(), 'ev-1')).resolves.toMatchObject({
      currency: 'USD',
    });
  });

  it('falls back to INR for an event with no ticket types yet', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE', role: Role.ORGANIZER_OWNER });
    prisma.ticketType.findFirst.mockResolvedValueOnce(null);
    await expect(service.organizerEventReport(asUser(), 'ev-1')).resolves.toMatchObject({
      currency: 'INR',
    });
  });

  it('allows ORGANIZER_MANAGER', async () => {
    const { service } = makeService({ status: 'ACTIVE', role: Role.ORGANIZER_MANAGER });
    await expect(service.organizerEventReport(asUser(), 'ev-1')).resolves.toMatchObject({
      event: { id: 'ev-1' },
    });
  });

  it('refuses a platform admin who is not a member: a platform role opens no organizer report', async () => {
    const { service } = makeService(null);
    await expect(service.organizerEventReport(asUser([Role.ADMIN]), 'ev-1')).rejects.toMatchObject({
      code: 'TENANT_FORBIDDEN',
    });
    await expect(
      service.organizerEventReport(asUser([Role.SUPER_ADMIN]), 'ev-1'),
    ).rejects.toMatchObject({ code: 'TENANT_FORBIDDEN' });
  });

  it('returns null for a missing event (no authz check)', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE', role: Role.CHECKIN_STAFF });
    prisma.event.findUnique.mockResolvedValueOnce(null);
    await expect(service.organizerEventReport(asUser(), 'missing')).resolves.toBeNull();
  });
});

describe('ReportsService.organizerEventReport sales by day', () => {
  const owner = { status: 'ACTIVE', role: Role.ORGANIZER_OWNER };

  it('puts a late-evening IST sale on the venue day, not the UTC day', async () => {
    // 11:26 pm IST on 13 Oct is 17:56 UTC on 13 Oct; 1:30 am IST on 14 Oct is 20:00 UTC on 13 Oct.
    const { service, prisma } = makeService(owner, {
      venue: { timezone: 'Asia/Kolkata', country: 'India' },
    });
    prisma.booking.findMany.mockResolvedValue([
      { confirmedAt: new Date('2026-10-13T17:56:00Z'), subtotalMinor: 25000 },
      { confirmedAt: new Date('2026-10-13T20:00:00Z'), subtotalMinor: 10000 },
      { confirmedAt: new Date('2026-10-12T19:00:00Z'), subtotalMinor: 5000 },
    ]);
    const r = await service.organizerEventReport(asUser(), 'ev-1');
    expect(r?.salesDayZone).toBe('Asia/Kolkata');
    expect(r?.salesByDay).toEqual([
      { day: '2026-10-13', bookings: 2, grossMinor: 30000 },
      { day: '2026-10-14', bookings: 1, grossMinor: 10000 },
    ]);
  });

  it('uses the venue zone for a US event too', async () => {
    const { service, prisma } = makeService(owner, {
      venue: { timezone: 'America/Los_Angeles', country: 'United States' },
    });
    // 03:00 UTC on 14 Oct is 8:00 pm PDT on 13 Oct.
    prisma.booking.findMany.mockResolvedValue([
      { confirmedAt: new Date('2026-10-14T03:00:00Z'), subtotalMinor: 7000 },
    ]);
    const r = await service.organizerEventReport(asUser(), 'ev-1');
    expect(r?.salesByDay).toEqual([{ day: '2026-10-13', bookings: 1, grossMinor: 7000 }]);
  });
});
