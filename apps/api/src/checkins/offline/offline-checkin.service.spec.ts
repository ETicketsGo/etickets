import { OfflineManifestService } from './offline-manifest.service';
import { OfflineReconciliationService } from './offline-reconciliation.service';
import { OfflineCheckinReadinessService } from './offline-readiness.service';
import {
  OfflineDrillService,
  DRILL_EVIDENCE_TTL_MS,
  type DrillEvidence,
} from './offline-drill.service';
import { OfflineActivationService } from './offline-activation.service';
import type { ActivationInputs } from '@eticketsgo/shared-types';
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
    deviceId: 'dev1',
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

  it('signs the device: a list issued to one device does not verify for another (H5)', () => {
    const signature = svc.sign(meta, entries);
    expect(svc.verify({ meta: { ...meta, deviceId: 'dev2' }, entries, signature })).toBe(false);
  });
});

const NO_DRILLS: DrillEvidence = {
  twoDeviceDrillPassed: false,
  deviceLossDrillPassed: false,
  reconciliationDrillPassed: false,
};

const ALL_GREEN: ActivationInputs = {
  flagEnabled: true,
  organizationApproved: true,
  eventApproved: true,
  deviceApproved: true,
  manifestValid: true,
  deltaFresh: true,
  queueOperational: true,
  reconciliationOperational: true,
  alertsOperational: true,
  auditHealthy: true,
  twoDeviceDrillPassed: true,
  deviceLossDrillPassed: true,
  reconciliationDrillPassed: true,
  openCriticalFindings: 0,
  adminActivationRecorded: false,
};
function activationsStub(inputs: Partial<ActivationInputs> = {}) {
  return {
    computeInputs: jest.fn().mockResolvedValue({ ...ALL_GREEN, ...inputs }),
  } as unknown as OfflineActivationService;
}

describe('OfflineCheckinReadinessService', () => {
  function setup(enabled: boolean, approved = 0, activations = activationsStub()) {
    const prisma = {
      checkInDevice: { count: jest.fn().mockResolvedValue(approved) },
      checkInManifest: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const cfg = {
      get: (k: string) => (k === 'OFFLINE_CHECKIN_ENABLED' ? enabled : undefined),
    } as never;
    return new OfflineCheckinReadinessService(prisma, cfg, activations);
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

  it('activation stays NO_GO while the admin decision is unrecorded', async () => {
    const { verdict, checks } = await setup(true, 1, activationsStub()).activation('org1', 's1');
    expect(verdict).toBe('NO_GO');
    expect(checks.find((c) => c.key === 'activation')?.passed).toBe(false);
  });

  it('activation is GO for a certified, approved, non-downgraded scope', async () => {
    const { verdict } = await setup(
      true,
      1,
      activationsStub({ adminActivationRecorded: true }),
    ).activation('org1', 's1');
    expect(verdict).toBe('GO');
  });
});

describe('OfflineDrillService.drillEvidence (fail-closed)', () => {
  function svcWith(latest: (key: string) => unknown) {
    const prisma = {
      offlineDrillRun: {
        findFirst: jest.fn((args: { where: { drillKey: string } }) =>
          Promise.resolve(latest(args.where.drillKey)),
        ),
      },
    } as unknown as PrismaService;
    return new OfflineDrillService(prisma, access, audit);
  }

  it('reports every drill false when nothing is recorded', async () => {
    const ev = await svcWith(() => null).drillEvidence('org1');
    expect(ev).toEqual(NO_DRILLS);
  });

  it('counts a fresh PASS for its own key only', async () => {
    const now = 1_000_000_000_000;
    const svc = svcWith((key) =>
      key === 'TWO_DEVICE_CONFLICT' ? { outcome: 'PASS', createdAt: new Date(now - 1000) } : null,
    );
    const ev = await svc.drillEvidence('org1', now);
    expect(ev.twoDeviceDrillPassed).toBe(true);
    expect(ev.deviceLossDrillPassed).toBe(false);
    expect(ev.reconciliationDrillPassed).toBe(false);
  });

  it('does not count a stale PASS', async () => {
    const now = 1_000_000_000_000;
    const svc = svcWith(() => ({
      outcome: 'PASS',
      createdAt: new Date(now - DRILL_EVIDENCE_TTL_MS - 1),
    }));
    const ev = await svc.drillEvidence('org1', now);
    expect(ev.twoDeviceDrillPassed).toBe(false);
  });

  it('does not count when the latest run FAILED', async () => {
    const now = 1_000_000_000_000;
    const svc = svcWith(() => ({ outcome: 'FAIL', createdAt: new Date(now - 1000) }));
    const ev = await svc.drillEvidence('org1', now);
    expect(ev.twoDeviceDrillPassed).toBe(false);
  });
});

/** The stored header of the list the queued scans in these tests cite. */
const ISSUED = {
  eventSessionId: 'se1',
  version: 1,
  deviceId: 'dev1',
  validFrom: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 30 * 60_000),
  signature: 'sig-1',
};

describe('OfflineReconciliationService', () => {
  it('idempotently accepts a clean check-in and records an audit', async () => {
    const ticket = {
      id: 'tk1',
      status: 'ACTIVE',
      nonce: 'n1',
      qrVersion: 1,
      eventSessionId: 'se1',
      checkIns: [],
      // The device's own organization, so the ticket is one this device may admit.
      eventSession: { event: { organizationId: 'org1' } },
    };
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED' }) },
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
      offlineReconciliationRecord: { create: jest.fn().mockResolvedValue({ id: 'rec1' }) },
      checkInManifest: { findMany: jest.fn().mockResolvedValue([ISSUED]) },
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
        manifestVersion: 1,
        manifestSignature: 'sig-1',
      },
    ]);
    expect(res).toEqual([{ ticketId: 'tk1', outcome: 'ACCEPTED' }]);
    expect(prisma.checkIn.create as jest.Mock).toHaveBeenCalled();
  });

  it('surfaces a transfer that happened after manifest download (server wins)', async () => {
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED' }) },
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
          eventSession: { event: { organizationId: 'org1' } },
        }),
        updateMany: jest.fn(),
      },
      checkIn: { create: jest.fn() },
      offlineReconciliationRecord: { create: jest.fn().mockResolvedValue({ id: 'rec1' }) },
      checkInManifest: { findMany: jest.fn().mockResolvedValue([ISSUED]) },
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
        manifestVersion: 1,
        manifestSignature: 'sig-1',
      },
    ]);
    expect(res[0].outcome).toBe('TRANSFERRED_AFTER_DOWNLOAD');
    expect(prisma.ticket.updateMany as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('OfflineReconciliationService organization boundary', () => {
  it("will not check in another organization's ticket", async () => {
    /*
      The caller is authorized for the DEVICE's organization and the queued ticket id was
      trusted as-is, so staff of one organization could spend another's admission. A foreign
      ticket is treated as one that does not exist: nothing claimed, sent to review.
    */
    const updateMany = jest.fn();
    const checkInCreate = jest.fn();
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED' }) },
      checkInDevice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'dev1', organizationId: 'org1', status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tk-foreign',
          status: 'ACTIVE',
          nonce: 'n1',
          qrVersion: 1,
          eventSessionId: 'se1',
          checkIns: [],
          eventSession: { event: { organizationId: 'org2' } },
        }),
        updateMany,
      },
      checkIn: { create: checkInCreate },
      offlineReconciliationRecord: { create: jest.fn().mockResolvedValue({ id: 'rec1' }) },
      checkInManifest: { findMany: jest.fn().mockResolvedValue([ISSUED]) },
    } as unknown as PrismaService;
    const svc = new OfflineReconciliationService(prisma, access, audit);

    const res = await svc.reconcile(USER, 'dev1', [
      {
        ticketId: 'tk-foreign',
        deviceId: 'dev1',
        nonce: 'n1',
        version: 1,
        eventSessionId: 'se1',
        checkedInAt: Date.now(),
        wasOverride: false,
        manifestVersion: 1,
        manifestSignature: 'sig-1',
      },
    ]);

    expect(res).toEqual([{ ticketId: 'tk-foreign', outcome: 'SUPERVISOR_REVIEW_REQUIRED' }]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(checkInCreate).not.toHaveBeenCalled();
  });
});

describe('OfflineReconciliationService and a suspension', () => {
  const scan = (ticketId: string) => ({
    ticketId,
    deviceId: 'dev1',
    nonce: 'n1',
    version: 1,
    eventSessionId: 'se1',
    checkedInAt: Date.now(),
    wasOverride: false,
    manifestVersion: 1,
    manifestSignature: 'sig-1',
  });
  const activeTicket = (id: string) => ({
    id,
    status: 'ACTIVE',
    nonce: 'n1',
    qrVersion: 1,
    eventSessionId: 'se1',
    checkIns: [],
    eventSession: { event: { organizationId: 'org1' } },
  });

  it('stops claiming the moment a suspension lands part-way through an upload', async () => {
    /*
      The organization is APPROVED when the upload starts and SUSPENDED by the first claim: the
      claim's own filter refuses it, and every later scan in the queue is held, not applied.
    */
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const checkInCreate = jest.fn();
    const prisma = {
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ status: 'APPROVED' })
          .mockResolvedValue({ status: 'SUSPENDED' }),
      },
      checkInDevice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'dev1', organizationId: 'org1', status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ticket: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(activeTicket(where.id)),
        ),
        updateMany,
      },
      checkIn: { create: checkInCreate },
      offlineReconciliationRecord: { create: jest.fn().mockResolvedValue({ id: 'rec1' }) },
      checkInManifest: { findMany: jest.fn().mockResolvedValue([ISSUED]) },
    } as unknown as PrismaService;
    const svc = new OfflineReconciliationService(prisma, access, audit);

    const res = await svc.reconcile(USER, 'dev1', [scan('tk1'), scan('tk2')]);

    expect(res).toEqual([
      { ticketId: 'tk1', outcome: 'DEVICE_NOT_ACTIVE' },
      { ticketId: 'tk2', outcome: 'DEVICE_NOT_ACTIVE' },
    ]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      eventSession: { event: { organization: { status: { not: 'SUSPENDED' } } } },
    });
    expect(checkInCreate).not.toHaveBeenCalled();
  });

  it('refuses a suspended organization upload, names every scan, and applies none', async () => {
    const updateMany = jest.fn();
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ status: 'SUSPENDED' }) },
      organizationMember: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'CHECKIN_STAFF' }),
      },
      checkInDevice: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'dev1',
          organizationId: 'org1',
          eventId: null,
          status: 'REVOKED',
          expiresAt: null,
        }),
      },
      ticket: { updateMany },
      offlineReconciliationRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'rec1' }),
      },
      checkInManifest: { findMany: jest.fn().mockResolvedValue([ISSUED]) },
    } as unknown as PrismaService;
    const svc = new OfflineReconciliationService(prisma, access, audit);

    await expect(svc.reconcile(USER, 'dev1', [scan('tk1'), scan('tk2')])).rejects.toMatchObject({
      code: 'ORGANIZATION_SUSPENDED',
      details: {
        heldForReview: 2,
        rejected: [
          expect.objectContaining({ ticketId: 'tk1', reason: 'ORGANIZATION_SUSPENDED' }),
          expect.objectContaining({ ticketId: 'tk2', reason: 'ORGANIZATION_SUSPENDED' }),
        ],
      },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
