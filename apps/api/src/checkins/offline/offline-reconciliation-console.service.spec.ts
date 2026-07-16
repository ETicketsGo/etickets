import { OfflineReconciliationConsoleService } from './offline-reconciliation-console.service';
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

function build(record: unknown, update = jest.fn().mockResolvedValue({ id: 'rec1' })) {
  const prisma = {
    offlineReconciliationRecord: {
      findUnique: jest.fn().mockResolvedValue(record),
      update,
    },
  } as unknown as PrismaService;
  const access = {
    assertMember: jest.fn().mockResolvedValue(undefined),
  } as unknown as OrgAccessService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return {
    svc: new OfflineReconciliationConsoleService(prisma, access, audit),
    update,
    audit,
    access,
  };
}

const pendingReview = {
  id: 'rec1',
  organizationId: 'org1',
  ticketId: 'tk1',
  outcome: 'SUPERVISOR_REVIEW_REQUIRED',
  reviewState: 'PENDING',
};

describe('OfflineReconciliationConsoleService.resolve (safe, audited)', () => {
  it('resolves a pending supervisor-review case and audits it', async () => {
    const { svc, update, audit } = build(pendingReview);
    await svc.resolve(USER, 'rec1', 'ACKNOWLEDGED', 'Verified in person.');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rec1' },
        data: expect.objectContaining({
          reviewState: 'RESOLVED',
          resolutionAction: 'ACKNOWLEDGED',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFLINE_RECONCILIATION_RESOLVED' }),
    );
  });

  it('requires a reason', async () => {
    const { svc, update } = build(pendingReview);
    await expect(svc.resolve(USER, 'rec1', 'DISMISSED', '   ')).rejects.toBeInstanceOf(
      AppException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to resolve a non-review outcome (never converts to an admission)', async () => {
    const { svc, update } = build({
      ...pendingReview,
      outcome: 'WRONG_SESSION',
      reviewState: 'PENDING',
    });
    await expect(svc.resolve(USER, 'rec1', 'ACKNOWLEDGED', 'reason')).rejects.toBeInstanceOf(
      AppException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to re-resolve an already RESOLVED record (invalid transition)', async () => {
    const { svc, update } = build({ ...pendingReview, reviewState: 'RESOLVED' });
    await expect(svc.resolve(USER, 'rec1', 'DISMISSED', 'reason')).rejects.toBeInstanceOf(
      AppException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('404s when the record does not exist', async () => {
    const { svc } = build(null);
    await expect(svc.resolve(USER, 'missing', 'ACKNOWLEDGED', 'reason')).rejects.toBeInstanceOf(
      AppException,
    );
  });
});

describe('OfflineReconciliationConsoleService.list (filters + pagination caps)', () => {
  function listSvc(count = 3) {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      $transaction: jest.fn(() => Promise.resolve([count, []])),
      offlineReconciliationRecord: { count: jest.fn().mockResolvedValue(count), findMany },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const access = {
      assertMember: jest.fn().mockResolvedValue(undefined),
    } as unknown as OrgAccessService;
    const audit = { record: jest.fn() } as unknown as AuditService;
    return {
      svc: new OfflineReconciliationConsoleService(prisma, access, audit),
      access,
    };
  }

  it('caps pageSize at 100 and clamps page to >= 1', async () => {
    const { svc } = listSvc(250);
    const res = await svc.list(USER, { organizationId: 'org1', page: 0, pageSize: 9999 });
    expect(res.meta.pageSize).toBe(100);
    expect(res.meta.page).toBe(1);
    expect(res.meta.total).toBe(250);
    expect(res.meta.totalPages).toBe(3);
  });

  it('enforces organization membership before reading', async () => {
    const { svc, access } = listSvc();
    await svc.list(USER, { organizationId: 'org1' });
    expect(access.assertMember).toHaveBeenCalledWith(USER, 'org1', expect.any(Array));
  });
});
