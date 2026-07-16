import { OfflineCommandCenterService } from './offline-command-center.service';
import { OfflineCheckinReadinessService } from './offline-readiness.service';
import { OfflineActivationService } from './offline-activation.service';
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

function build(prisma: Partial<Record<string, unknown>>) {
  const access = {
    assertMember: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrgAccessService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const readiness = {} as unknown as OfflineCheckinReadinessService;
  const activations = {} as unknown as OfflineActivationService;
  return {
    svc: new OfflineCommandCenterService(
      prisma as unknown as PrismaService,
      access,
      audit,
      readiness,
      activations,
    ),
    audit,
    access,
  };
}

describe('OfflineCommandCenterService.acknowledgeAlert (manager, reason, audited)', () => {
  const okInput = {
    organizationId: 'org1',
    eventSessionId: 's1',
    alertKey: 'STALE_MANIFEST:s1',
    severity: 'warning' as const,
    reason: 'On it — refreshing the manifest.',
  };

  it('upserts an acknowledgement idempotently and audits it', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'ack1' });
    const { svc, audit } = build({ offlineAlertAck: { upsert } });
    await svc.acknowledgeAlert(USER, okInput);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventSessionId_alertKey: { eventSessionId: 's1', alertKey: 'STALE_MANIFEST:s1' } },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFLINE_ALERT_ACKNOWLEDGED' }),
    );
  });

  it('requires a reason', async () => {
    const upsert = jest.fn();
    const { svc } = build({ offlineAlertAck: { upsert } });
    await expect(svc.acknowledgeAlert(USER, { ...okInput, reason: '  ' })).rejects.toBeInstanceOf(
      AppException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('requires an alert key', async () => {
    const upsert = jest.fn();
    const { svc } = build({ offlineAlertAck: { upsert } });
    await expect(svc.acknowledgeAlert(USER, { ...okInput, alertKey: '' })).rejects.toBeInstanceOf(
      AppException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('OfflineCommandCenterService.activity (bounded + paginated)', () => {
  function svcWith(total: number) {
    return build({
      $transaction: jest.fn(() => Promise.resolve([total, []])),
      auditLog: {
        count: jest.fn().mockResolvedValue(total),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
  }

  it('caps pageSize at 100 and clamps page to >= 1', async () => {
    const { svc } = svcWith(500);
    const res = await svc.activity(USER, 'org1', 0, 9999);
    expect(res.meta.pageSize).toBe(100);
    expect(res.meta.page).toBe(1);
    expect(res.meta.total).toBe(500);
    expect(res.meta.totalPages).toBe(5);
  });

  it('checks org membership before reading', async () => {
    const { svc, access } = svcWith(0);
    await svc.activity(USER, 'org1');
    expect(access.assertMember).toHaveBeenCalledWith(USER, 'org1', expect.any(Array));
  });
});
