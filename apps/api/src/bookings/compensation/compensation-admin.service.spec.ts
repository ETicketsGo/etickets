import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/errors';
import { CompensationAdminService, type AdminScope } from './compensation-admin.service';
import { CompensationRepository } from './compensation.repository';
import { CompensationPlanner } from './compensation-planner';
import { CompensationState } from './compensation-state';
import { CompensationType } from './compensation-types';

function make(record: Record<string, unknown> | null) {
  const findUnique = jest.fn().mockResolvedValue(record);
  const findMany = jest.fn().mockResolvedValue([]);
  const advance = jest.fn(async (r: Record<string, unknown>, state: string, patch = {}) => ({
    ...r,
    ...patch,
    state,
  }));
  const prisma = {
    bookingCompensation: {
      findUnique,
      findMany,
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService;
  const repo = { advance } as unknown as CompensationRepository;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { get: jest.fn(() => false) } as never; // auto-void off by default in tests
  const svc = new CompensationAdminService(prisma, repo, new CompensationPlanner(), audit, config);
  return { svc, findUnique, findMany, advance, audit };
}

const rec = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  bookingId: 'b1',
  tenantId: 't1',
  compensationType: CompensationType.REDIS_LOCK_RELEASE,
  state: CompensationState.PLANNED,
  version: 0,
  amountMinor: null,
  ...over,
});

const tenantAdmin: AdminScope = { actorUserId: 'u1', isSuperAdmin: false, tenantId: 't1' };
const otherTenant: AdminScope = { actorUserId: 'u2', isSuperAdmin: false, tenantId: 't2' };
const superAdmin: AdminScope = { actorUserId: 'root', isSuperAdmin: true };

describe('CompensationAdminService — tenant isolation', () => {
  it('rejects cross-tenant access as not-found (never reveals another tenant record)', async () => {
    const { svc } = make(rec({ tenantId: 't1' }));
    await expect(svc.inspect(otherTenant, 'c1')).rejects.toBeInstanceOf(AppException);
  });

  it('allows the owning tenant', async () => {
    const { svc } = make(rec({ tenantId: 't1' }));
    await expect(svc.inspect(tenantAdmin, 'c1')).resolves.toBeTruthy();
  });

  it('super-admin may access any tenant', async () => {
    const { svc } = make(rec({ tenantId: 't9' }));
    await expect(svc.inspect(superAdmin, 'c1')).resolves.toBeTruthy();
  });

  it('list narrows a non-super-admin to its tenant; a missing tenant fails closed', async () => {
    const { svc, findMany } = make(null);
    await svc.list({ actorUserId: 'u', isSuperAdmin: false, tenantId: undefined });
    // A missing tenant fails closed — the filter is a sentinel that matches no real record.
    expect(findMany.mock.calls[0][0].where.tenantId).toMatch(/no_tenant/);
  });
});

describe('CompensationAdminService — non-financial safety', () => {
  it('refuses to approve a financial (refund/void) action', async () => {
    const { svc } = make(rec({ compensationType: CompensationType.PAYMENT_REFUND }));
    await expect(svc.approve(tenantAdmin, 'c1')).rejects.toBeInstanceOf(AppException);
  });

  it('refuses to approve a confirmed-provider-booking cancellation', async () => {
    const { svc } = make(rec({ compensationType: CompensationType.PROVIDER_BOOKING_CANCEL }));
    await expect(svc.approve(tenantAdmin, 'c1')).rejects.toBeInstanceOf(AppException);
  });

  it('approves a SAFE non-financial action to READY without touching amount/type', async () => {
    const { svc, advance } = make(rec({ compensationType: CompensationType.REDIS_LOCK_RELEASE }));
    const out = await svc.approve(tenantAdmin, 'c1');
    expect(advance).toHaveBeenCalledWith(expect.anything(), CompensationState.READY);
    // The mutation only changes state — never amount or type (no such field is passed).
    const patch = advance.mock.calls[0][2];
    expect(patch).toBeUndefined();
    expect(out.compensationType).toBe(CompensationType.REDIS_LOCK_RELEASE);
  });

  it('refuses to retry a financial action', async () => {
    const { svc } = make(
      rec({
        compensationType: CompensationType.PAYMENT_VOID,
        state: CompensationState.RETRYABLE_FAILURE,
      }),
    );
    await expect(svc.retry(tenantAdmin, 'c1')).rejects.toBeInstanceOf(AppException);
  });

  it('release-lease only applies to a processing record', async () => {
    const { svc } = make(rec({ state: CompensationState.READY }));
    await expect(svc.releaseLease(tenantAdmin, 'c1')).rejects.toBeInstanceOf(AppException);
  });

  it('audits every mutation', async () => {
    const { svc, audit } = make(rec({ compensationType: CompensationType.REDIS_LOCK_RELEASE }));
    await svc.approve(tenantAdmin, 'c1');
    expect(audit.record as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMPENSATION_APPROVED',
        entityType: 'BookingCompensation',
      }),
    );
  });
});

describe('CompensationAdminService — dry run is read-only', () => {
  it('returns a plan without persisting or moving money', async () => {
    const { svc, advance } = make(null);
    const out = svc.dryRun(tenantAdmin, {
      bookingId: 'b1',
      reasonCode: 'X',
      redisFinalizeFailed: true,
    });
    expect(out.classification).toBe('REDIS_FINALIZE_FAILED');
    expect(out.actions[0].safe).toBe(true);
    expect(advance).not.toHaveBeenCalled();
  });
});
