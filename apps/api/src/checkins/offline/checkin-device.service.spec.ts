import { CheckInDeviceService } from './checkin-device.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

const USER: RequestUser = {
  id: 'mgr1',
  email: 'mgr@e.test',
  fullName: 'Manager',
  roles: ['ORGANIZER_MANAGER'] as never,
};

function build(device: unknown, update = jest.fn().mockResolvedValue({ id: 'd1' })) {
  const prisma = {
    checkInDevice: { findUnique: jest.fn().mockResolvedValue(device), update },
  } as unknown as PrismaService;
  const access = {
    assertMember: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrgAccessService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { svc: new CheckInDeviceService(prisma, access, audit), update, audit };
}

const activeDevice = { id: 'd1', organizationId: 'org1', status: 'ACTIVE' };

describe('CheckInDeviceService lifecycle (audited)', () => {
  it('suspends an active device and audits it', async () => {
    const { svc, update, audit } = build(activeDevice);
    await svc.suspend(USER, 'd1', 'Rotating operators');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUSPENDED' } }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CHECKIN_DEVICE_SUSPENDED',
        metadata: { reason: 'Rotating operators' },
      }),
    );
  });

  it('refuses to suspend a revoked device', async () => {
    const { svc, update } = build({ ...activeDevice, status: 'REVOKED' });
    await expect(svc.suspend(USER, 'd1')).rejects.toBeInstanceOf(AppException);
    expect(update).not.toHaveBeenCalled();
  });

  it('revokes with a reason recorded in the audit metadata', async () => {
    const { svc, update, audit } = build(activeDevice);
    await svc.revoke(USER, 'd1', 'Decommissioned');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'REVOKED',
          revokedAt: expect.any(Date),
          revokeReason: 'MANUAL',
          revokeReasons: { push: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z MANUAL$/) },
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CHECKIN_DEVICE_REVOKED',
        metadata: { reason: 'Decommissioned' },
      }),
    );
  });

  it('keeps the first revocation time and reason, and appends the later reason, when revoked again', async () => {
    const first = new Date('2026-10-26T10:00:00Z');
    const { svc, update } = build({
      ...activeDevice,
      status: 'REVOKED',
      revokedAt: first,
      revokeReason: 'ORGANIZATION_SUSPENDED',
    });
    await svc.revoke(USER, 'd1', 'Tidying up');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'REVOKED',
          revokedAt: first,
          revokeReason: 'ORGANIZATION_SUSPENDED',
          revokeReasons: { push: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z MANUAL$/) },
        },
      }),
    );
  });

  it('reports lost — revokes and records a distinct audit action', async () => {
    const { svc, update, audit } = build(activeDevice);
    await svc.reportLost(USER, 'd1', 'Left in a taxi');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'REVOKED',
          revokedAt: expect.any(Date),
          revokeReason: 'LOST',
          revokeReasons: { push: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z LOST$/) },
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CHECKIN_DEVICE_REPORTED_LOST',
        metadata: { reason: 'Left in a taxi', lost: true },
      }),
    );
  });

  it('approves a pending device and brings a suspended one back', async () => {
    for (const status of ['PENDING', 'SUSPENDED']) {
      const { svc, update } = build({ ...activeDevice, status });
      await svc.approve(USER, 'd1');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
    }
  });

  it('refuses to approve a revoked device: revoked is final', async () => {
    const { svc, update, audit } = build({ ...activeDevice, status: 'REVOKED' });
    await expect(svc.approve(USER, 'd1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s a lifecycle action on a missing device', async () => {
    const { svc } = build(null);
    await expect(svc.revoke(USER, 'missing', 'x')).rejects.toBeInstanceOf(AppException);
  });
});
