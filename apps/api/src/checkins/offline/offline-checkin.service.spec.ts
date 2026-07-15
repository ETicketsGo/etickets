import { OfflineManifestService } from './offline-manifest.service';
import { OfflineReconciliationService } from './offline-reconciliation.service';
import { OfflineCheckinReadinessService } from './offline-readiness.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import type { RequestUser } from '../../common/decorators';

const USER: RequestUser = {
  id: 'u1',
  email: 'staff@e.test',
  fullName: 'Staff',
  roles: ['ORGANIZER_OWNER'] as never,
};
const config = { get: () => 'manifest-secret', getOrThrow: () => 'manifest-secret' } as never;
const access = {
  assertMember: jest.fn().mockResolvedValue(undefined),
} as unknown as OrgAccessService;
const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

describe('OfflineManifestService signing', () => {
  const svc = new OfflineManifestService({} as PrismaService, config, access, audit);
  const meta = {
    organizationId: 'org1',
    eventId: 'ev1',
    eventSessionId: 'se1',
    version: 1,
    validFrom: 1,
    expiresAt: 2,
  };
  const entries = [
    {
      ticketId: 'tk1',
      eventSessionId: 'se1',
      nonce: 'n1',
      version: 1,
      status: 'ACTIVE',
      eligible: true,
    },
  ];

  it('signs deterministically and verifies a good manifest', () => {
    const signature = svc.sign(meta, entries);
    expect(svc.verify({ meta, entries, signature })).toBe(true);
  });

  it('rejects a tampered manifest (nonce swap)', () => {
    const signature = svc.sign(meta, entries);
    const tampered = { meta, entries: [{ ...entries[0], nonce: 'forged' }], signature };
    expect(svc.verify(tampered)).toBe(false);
  });
});

describe('OfflineCheckinReadinessService', () => {
  function setup(enabled: boolean, approved = 0) {
    const prisma = {
      checkInDevice: { count: jest.fn().mockResolvedValue(approved) },
      checkInManifest: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const cfg = {
      get: (k: string) => (k === 'OFFLINE_CHECKIN_ENABLED' ? enabled : undefined),
    } as never;
    return new OfflineCheckinReadinessService(prisma, cfg);
  }

  it('is NO_GO while the feature flag is off', async () => {
    const r = await setup(false).report('org1');
    expect(r.verdict).toBe('NO_GO');
    expect(r.note).toMatch(/disabled/i);
  });

  it('is CONDITIONAL_GO when enabled but no approved device', async () => {
    const r = await setup(true, 0).report('org1');
    expect(r.verdict).toBe('CONDITIONAL_GO');
  });
});

describe('OfflineReconciliationService', () => {
  it('idempotently accepts a clean check-in and records an audit', async () => {
    const ticket = {
      id: 'tk1',
      status: 'ACTIVE',
      nonce: 'n1',
      qrVersion: 1,
      eventSessionId: 'se1',
      checkIns: [],
    };
    const prisma = {
      checkInDevice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'dev1', organizationId: 'org1', status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ticket: {
        findUnique: jest.fn().mockResolvedValue(ticket),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      checkIn: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const svc = new OfflineReconciliationService(prisma, access, audit);

    const res = await svc.reconcile(USER, 'dev1', [
      {
        ticketId: 'tk1',
        deviceId: 'dev1',
        nonce: 'n1',
        version: 1,
        eventSessionId: 'se1',
        checkedInAt: Date.now(),
        wasOverride: false,
      },
    ]);
    expect(res).toEqual([{ ticketId: 'tk1', outcome: 'ACCEPTED' }]);
    expect(prisma.checkIn.create as jest.Mock).toHaveBeenCalled();
  });

  it('surfaces a transfer that happened after manifest download (server wins)', async () => {
    const prisma = {
      checkInDevice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'dev1', organizationId: 'org1', status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tk1',
          status: 'ACTIVE',
          nonce: 'ROTATED',
          qrVersion: 2,
          eventSessionId: 'se1',
          checkIns: [],
        }),
        updateMany: jest.fn(),
      },
      checkIn: { create: jest.fn() },
    } as unknown as PrismaService;
    const svc = new OfflineReconciliationService(prisma, access, audit);
    const res = await svc.reconcile(USER, 'dev1', [
      {
        ticketId: 'tk1',
        deviceId: 'dev1',
        nonce: 'n1',
        version: 1,
        eventSessionId: 'se1',
        checkedInAt: Date.now(),
        wasOverride: false,
      },
    ]);
    expect(res[0].outcome).toBe('TRANSFERRED_AFTER_DOWNLOAD');
    expect(prisma.ticket.updateMany as jest.Mock).not.toHaveBeenCalled();
  });
});
