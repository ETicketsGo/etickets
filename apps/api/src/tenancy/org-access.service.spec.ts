import { AdminPermission, Role } from '@eticketsgo/shared-types';
import {
  OrgAccessService,
  PLATFORM_ORGANIZER_ACCESS_ALLOWED,
  PLATFORM_ORGANIZER_ACCESS_DENIED,
} from './org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { requestContext } from '../common/request-context';

const user = (roles: string[]): RequestUser => ({
  id: 'u1',
  email: 'u1@example.test',
  fullName: 'User One',
  roles: roles as never,
});

function setup(membership: { status: string; role: string } | null, grants: string[] = []) {
  const prisma = {
    organizationMember: {
      findUnique: jest.fn().mockResolvedValue(membership),
      findMany: jest.fn().mockResolvedValue([]),
    },
    adminGrant: {
      findMany: jest.fn().mockResolvedValue(grants.map((permission) => ({ permission }))),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new OrgAccessService(prisma as never, audit as never), prisma, audit };
}

const READ_POLICY = { permission: AdminPermission.ORGANIZER_READ, operation: 'organization.read' };

describe('OrgAccessService.isPlatformAdmin', () => {
  const { service } = setup(null);

  it('is true for ADMIN and SUPER_ADMIN', () => {
    expect(service.isPlatformAdmin(user([Role.ADMIN]))).toBe(true);
    expect(service.isPlatformAdmin(user([Role.SUPER_ADMIN]))).toBe(true);
  });

  it('is false for non-admin roles', () => {
    expect(service.isPlatformAdmin(user([Role.CUSTOMER]))).toBe(false);
    expect(service.isPlatformAdmin(user([Role.ORGANIZER_OWNER]))).toBe(false);
    expect(service.isPlatformAdmin(user([]))).toBe(false);
  });
});

describe('OrgAccessService.assertMember - organization members (unchanged)', () => {
  it('passes for an active member with no role restriction', async () => {
    const { service, prisma } = setup({ status: 'ACTIVE', role: Role.ORGANIZER_MANAGER });
    await expect(service.assertMember(user([Role.CUSTOMER]), 'org-1')).resolves.toBeUndefined();
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: 'org-1', userId: 'u1' } },
    });
  });

  it('throws TENANT_FORBIDDEN for a non-member', async () => {
    const { service } = setup(null);
    await expect(service.assertMember(user([Role.CUSTOMER]), 'org-1')).rejects.toMatchObject({
      code: ErrorCodes.TENANT_FORBIDDEN,
    });
  });

  it('throws TENANT_FORBIDDEN for an inactive (non-ACTIVE) membership', async () => {
    const { service } = setup({ status: 'INVITED', role: Role.ORGANIZER_OWNER });
    await expect(service.assertMember(user([Role.CUSTOMER]), 'org-1')).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('rejects a member whose role is not in allowedRoles', async () => {
    const { service } = setup({ status: 'ACTIVE', role: Role.CHECKIN_STAFF });
    await expect(
      service.assertMember(user([Role.CUSTOMER]), 'org-1', [Role.ORGANIZER_OWNER]),
    ).rejects.toMatchObject({ code: ErrorCodes.TENANT_FORBIDDEN });
  });

  it('accepts a member whose role is in allowedRoles', async () => {
    const { service } = setup({ status: 'ACTIVE', role: Role.ORGANIZER_OWNER });
    await expect(
      service.assertMember(user([Role.CUSTOMER]), 'org-1', [Role.ORGANIZER_OWNER]),
    ).resolves.toBeUndefined();
  });

  it('writes no audit row for members or for refused non-staff', async () => {
    const member = setup({ status: 'ACTIVE', role: Role.ORGANIZER_OWNER });
    await member.service.assertMember(user([Role.CUSTOMER]), 'org-1');
    expect(member.audit.record).not.toHaveBeenCalled();
    const stranger = setup(null);
    await expect(stranger.service.assertMember(user([Role.CUSTOMER]), 'org-1')).rejects.toThrow();
    expect(stranger.audit.record).not.toHaveBeenCalled();
  });
});

describe('OrgAccessService.assertMember - platform staff', () => {
  for (const roles of [[Role.ADMIN], [Role.ADMIN, Role.SUPER_ADMIN], [Role.SUPER_ADMIN]]) {
    const who = roles.join('+');

    it(`${who}: no membership and no named policy is REFUSED (the old bypass)`, async () => {
      // Every grant there is, and still refused: no capability opens an unlisted operation.
      const { service, audit } = setup(null, Object.values(AdminPermission));
      await expect(
        service.assertMember(user(roles), 'org-1', [Role.ORGANIZER_OWNER]),
      ).rejects.toMatchObject({ code: ErrorCodes.TENANT_FORBIDDEN });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'u1',
          organizationId: 'org-1',
          action: PLATFORM_ORGANIZER_ACCESS_DENIED,
          metadata: expect.objectContaining({ result: 'DENIED', reason: 'NO_PLATFORM_POLICY' }),
        }),
      );
    });
  }

  it('ADMIN with zero grants is refused a NAMED policy, and the refusal is audited', async () => {
    const { service, audit } = setup(null, []);
    await expect(
      service.assertMember(user([Role.ADMIN]), 'org-1', undefined, READ_POLICY),
    ).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PLATFORM_ORGANIZER_ACCESS_DENIED,
        organizationId: 'org-1',
        metadata: expect.objectContaining({
          operation: 'organization.read',
          permission: AdminPermission.ORGANIZER_READ,
          reason: 'CAPABILITY_MISSING',
        }),
      }),
    );
  });

  it('ADMIN holding a different capability is refused', async () => {
    const { service } = setup(null, [AdminPermission.PAYOUT_MANAGE, AdminPermission.BOOKING_READ]);
    await expect(
      service.assertMember(user([Role.ADMIN]), 'org-1', undefined, READ_POLICY),
    ).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN });
  });

  it('ADMIN holding the named capability passes, and the access is audited', async () => {
    const { service, audit } = setup(null, [AdminPermission.ORGANIZER_READ]);
    await expect(
      service.assertMember(user([Role.ADMIN]), 'org-1', undefined, READ_POLICY),
    ).resolves.toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'u1',
        organizationId: 'org-1',
        action: PLATFORM_ORGANIZER_ACCESS_ALLOWED,
        metadata: expect.objectContaining({ result: 'ALLOWED', operation: 'organization.read' }),
      }),
    );
  });

  it('SUPER_ADMIN passes a named policy by role, with no grant rows, and is audited', async () => {
    const { service, audit } = setup(null, []);
    await expect(
      service.assertMember(user([Role.ADMIN, Role.SUPER_ADMIN]), 'org-1', undefined, READ_POLICY),
    ).resolves.toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: PLATFORM_ORGANIZER_ACCESS_ALLOWED }),
    );
  });

  it('staff who ARE members act as members: no capability needed, no audit row', async () => {
    const { service, audit, prisma } = setup({ status: 'ACTIVE', role: Role.ORGANIZER_OWNER });
    await expect(
      service.assertMember(user([Role.ADMIN]), 'org-1', [Role.ORGANIZER_OWNER]),
    ).resolves.toBeUndefined();
    expect(prisma.adminGrant.findMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('staff who are members with the WRONG role get no platform shortcut', async () => {
    const { service } = setup({ status: 'ACTIVE', role: Role.CHECKIN_STAFF }, [
      AdminPermission.PAYOUT_MANAGE,
    ]);
    await expect(
      service.assertMember(user([Role.ADMIN]), 'org-1', [Role.ORGANIZER_OWNER]),
    ).rejects.toMatchObject({ code: ErrorCodes.TENANT_FORBIDDEN });
  });

  it('names the request on the audit row when one is in flight', async () => {
    const { service, audit } = setup(null);
    await requestContext.run(
      { correlationId: 'cid-9', method: 'POST', path: '/api/payouts/accounts' },
      () => expect(service.assertMember(user([Role.ADMIN]), 'org-1')).rejects.toThrow(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'cid-9',
        metadata: expect.objectContaining({
          operation: 'POST /api/payouts/accounts',
          request: 'POST /api/payouts/accounts',
        }),
      }),
    );
  });
});

describe('OrgAccessService.managedOrganizationIds', () => {
  it('returns memberships for platform staff too - never "every organization"', async () => {
    const { service, prisma } = setup(null);
    prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: 'org-own' }]);
    await expect(service.managedOrganizationIds(user([Role.SUPER_ADMIN]))).resolves.toEqual([
      'org-own',
    ]);
  });
});

describe('OrgAccessService.assertPlatformCapability', () => {
  const target = {
    permission: AdminPermission.REFUND_APPROVE,
    operation: 'refund.decide',
    organizationId: 'org-1',
    entityType: 'Refund',
    entityId: 'rf-1',
  };

  it('refuses a non-staff caller outright', async () => {
    const { service } = setup(null, [AdminPermission.REFUND_APPROVE]);
    await expect(
      service.assertPlatformCapability(user([Role.ORGANIZER_OWNER]), target),
    ).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN });
  });

  it('refuses staff without the grant, audited with the target', async () => {
    const { service, audit } = setup(null, [AdminPermission.REFUND_REVIEW]);
    await expect(service.assertPlatformCapability(user([Role.ADMIN]), target)).rejects.toThrow();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PLATFORM_ORGANIZER_ACCESS_DENIED,
        organizationId: 'org-1',
        entityType: 'Refund',
        entityId: 'rf-1',
      }),
    );
  });

  it('allows staff with the grant, audited', async () => {
    const { service, audit } = setup(null, [AdminPermission.REFUND_APPROVE]);
    await expect(
      service.assertPlatformCapability(user([Role.ADMIN]), target),
    ).resolves.toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: PLATFORM_ORGANIZER_ACCESS_ALLOWED }),
    );
  });
});
