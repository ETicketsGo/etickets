import { OfflineActivationService } from './offline-activation.service';
import { OfflineDrillService } from './offline-drill.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

const USER: RequestUser = {
  id: 'u1',
  email: 'owner@e.test',
  fullName: 'Owner',
  roles: ['ORGANIZER_OWNER'] as never,
};
const config = { get: () => true } as never;
const GREEN_DRILLS = {
  twoDeviceDrillPassed: true,
  deviceLossDrillPassed: true,
  reconciliationDrillPassed: true,
};

function future() {
  return new Date(Date.now() + 3_600_000);
}
function past() {
  return new Date(Date.now() - 1_000);
}

function build(prisma: Partial<Record<string, unknown>>, drillEvidence = GREEN_DRILLS) {
  const access = {
    assertMember: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrgAccessService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const drills = {
    drillEvidence: jest.fn().mockResolvedValue(drillEvidence),
  } as unknown as OfflineDrillService;
  const svc = new OfflineActivationService(
    prisma as unknown as PrismaService,
    config,
    access,
    audit,
    drills,
  );
  return { svc, access, audit };
}

describe('OfflineActivationService.computeInputs (fail-closed admin decision)', () => {
  it('reports adminActivationRecorded false when no decision exists', async () => {
    const { svc } = build({
      checkInDevice: { count: jest.fn().mockResolvedValue(1) },
      checkInManifest: { findFirst: jest.fn().mockResolvedValue({ expiresAt: future() }) },
      offlineActivation: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const inputs = await svc.computeInputs('org1', 's1');
    expect(inputs.adminActivationRecorded).toBe(false);
    // Everything else is green, so only the admin decision is missing.
    expect(inputs.twoDeviceDrillPassed).toBe(true);
    expect(inputs.manifestValid).toBe(true);
  });

  it('reports true for an ACTIVE decision whose devices + manifest are healthy', async () => {
    const { svc } = build({
      checkInDevice: { count: jest.fn().mockResolvedValue(1) },
      checkInManifest: { findFirst: jest.fn().mockResolvedValue({ expiresAt: future() }) },
      offlineActivation: {
        findFirst: jest.fn().mockResolvedValue({ deviceIds: ['d1'], eventSessionId: 's1' }),
      },
    });
    const inputs = await svc.computeInputs('org1', 's1');
    expect(inputs.adminActivationRecorded).toBe(true);
  });

  it('downgrades to false (mustDowngrade) when a scoped device is no longer ACTIVE', async () => {
    const { svc } = build({
      // id-scoped count (downgrade check) returns 0 → device revoked; org count returns 1.
      checkInDevice: {
        count: jest.fn((args: { where: { id?: unknown } }) =>
          Promise.resolve(args.where.id ? 0 : 1),
        ),
      },
      checkInManifest: { findFirst: jest.fn().mockResolvedValue({ expiresAt: future() }) },
      offlineActivation: {
        findFirst: jest.fn().mockResolvedValue({ deviceIds: ['d1'], eventSessionId: 's1' }),
      },
    });
    const inputs = await svc.computeInputs('org1', 's1');
    expect(inputs.adminActivationRecorded).toBe(false);
  });

  it('downgrades to false when the manifest has expired', async () => {
    const { svc } = build({
      checkInDevice: { count: jest.fn().mockResolvedValue(1) },
      checkInManifest: { findFirst: jest.fn().mockResolvedValue({ expiresAt: past() }) },
      offlineActivation: {
        findFirst: jest.fn().mockResolvedValue({ deviceIds: ['d1'], eventSessionId: 's1' }),
      },
    });
    const inputs = await svc.computeInputs('org1', 's1');
    expect(inputs.adminActivationRecorded).toBe(false);
  });
});

describe('OfflineActivationService.record (eligibility + fail-closed)', () => {
  const okSession = {
    checkInManifest: { findFirst: jest.fn().mockResolvedValue({ expiresAt: future() }) },
    eventSession: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 's1', event: { id: 'e1', organizationId: 'org1' } }),
    },
  };

  it('rejects when readiness is not GO (a drill is red)', async () => {
    const { svc } = build(
      {
        ...okSession,
        checkInDevice: {
          count: jest.fn().mockResolvedValue(1),
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'd1', status: 'ACTIVE', eventId: 'e1', expiresAt: future() },
            ]),
        },
      },
      { ...GREEN_DRILLS, reconciliationDrillPassed: false }, // stale/missing evidence
    );
    await expect(
      svc.record(USER, {
        organizationId: 'org1',
        eventSessionId: 's1',
        deviceIds: ['d1'],
        reason: 'pilot',
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('rejects a device that is not approved (ACTIVE)', async () => {
    const { svc } = build({
      ...okSession,
      checkInDevice: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'd1', status: 'PENDING', eventId: 'e1', expiresAt: future() }]),
      },
    });
    await expect(
      svc.record(USER, {
        organizationId: 'org1',
        eventSessionId: 's1',
        deviceIds: ['d1'],
        reason: 'pilot',
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('rejects when no device is in scope', async () => {
    const { svc } = build({
      ...okSession,
      checkInDevice: { count: jest.fn(), findMany: jest.fn() },
    });
    await expect(
      svc.record(USER, {
        organizationId: 'org1',
        eventSessionId: 's1',
        deviceIds: [],
        reason: 'pilot',
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('records an ACTIVE decision with an evidence snapshot when everything is green', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'act1' });
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const { svc, audit } = build({
      ...okSession,
      checkInDevice: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'd1', status: 'ACTIVE', eventId: 'e1', expiresAt: future() }]),
      },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
        cb({ offlineActivation: { updateMany, create } }),
      ),
    });
    const res = await svc.record(USER, {
      organizationId: 'org1',
      eventSessionId: 's1',
      deviceIds: ['d1'],
      reason: 'scoped pilot',
    });
    expect(res).toEqual({ id: 'act1' });
    expect(updateMany).toHaveBeenCalled(); // supersedes any prior ACTIVE
    const snapshot = create.mock.calls[0][0].data.evidenceSnapshot;
    expect(snapshot.checks).toBeDefined();
    expect(snapshot.deviceIds).toEqual(['d1']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFLINE_ACTIVATION_RECORDED' }),
    );
  });
});

describe('OfflineActivationService.revoke', () => {
  it('revokes an ACTIVE decision and audits it', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'act1', state: 'REVOKED' });
    const { svc, audit } = build({
      offlineActivation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'act1',
          organizationId: 'org1',
          state: 'ACTIVE',
          eventSessionId: 's1',
        }),
        update,
      },
    });
    await svc.revoke(USER, 'act1', 'device lost');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'act1' },
        data: expect.objectContaining({ state: 'REVOKED' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFLINE_ACTIVATION_REVOKED' }),
    );
  });

  it('refuses to revoke a decision that is not ACTIVE', async () => {
    const { svc } = build({
      offlineActivation: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'act1', organizationId: 'org1', state: 'REVOKED' }),
        update: jest.fn(),
      },
    });
    await expect(svc.revoke(USER, 'act1', 'again')).rejects.toBeInstanceOf(AppException);
  });
});
