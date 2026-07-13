import { Role } from '@eticketsgo/shared-types';
import { OrgAccessService } from './org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const user = (roles: string[]): RequestUser => ({
  id: 'u1',
  email: 'u1@example.test',
  fullName: 'User One',
  roles: roles as never,
});

function setup(membership: { status: string; role: string } | null) {
  const prisma = {
    organizationMember: {
      findUnique: jest.fn().mockResolvedValue(membership),
    },
  };
  return { service: new OrgAccessService(prisma as never), prisma };
}

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

describe('OrgAccessService.assertMember', () => {
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

  it('lets a platform admin bypass membership entirely (no DB lookup)', async () => {
    const { service, prisma } = setup(null);
    await expect(
      service.assertMember(user([Role.ADMIN]), 'org-1', [Role.ORGANIZER_OWNER]),
    ).resolves.toBeUndefined();
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });
});
