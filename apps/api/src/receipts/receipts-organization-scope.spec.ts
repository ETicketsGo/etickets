import 'reflect-metadata';
import { Role } from '@eticketsgo/shared-types';
import { OrganizationReceiptsController } from './receipts.controller';
import { OrgAccessService } from '../tenancy/org-access.service';
import { ErrorCodes } from '../common/errors';

/**
 * Who may list an organization's receipts, invoices and credit notes.
 *
 * The route's @Roles checks a GLOBAL role, and the membership check below it asked only
 * whether the caller belonged to the organization — so check-in staff, who scan tickets at
 * the door, could page through every document, each naming a buyer and an amount.
 */
function setup(role: string) {
  const prisma = {
    organizationMember: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role }) },
  };
  const receipts = {
    listForOrganization: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 }),
  };
  const controller = new OrganizationReceiptsController(
    receipts as never,
    new OrgAccessService(prisma as never),
  );
  return { controller, receipts };
}

const USER = { id: 'u-1', email: 'u@t.test', fullName: 'U', roles: [] } as never;

describe('OrganizationReceiptsController.list', () => {
  it('refuses check-in staff before reading any document', async () => {
    const { controller, receipts } = setup(Role.CHECKIN_STAFF);
    await expect(
      controller.list(USER, 'org-1', { page: 1, pageSize: 25 } as never),
    ).rejects.toMatchObject({ code: ErrorCodes.TENANT_FORBIDDEN });
    expect(receipts.listForOrganization).not.toHaveBeenCalled();
  });

  it.each([Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER])(
    'lets %s read the books',
    async (role) => {
      const { controller, receipts } = setup(role);
      await controller.list(USER, 'org-1', { page: 1, pageSize: 25 } as never);
      expect(receipts.listForOrganization).toHaveBeenCalledWith('org-1', { page: 1, pageSize: 25 });
    },
  );
});
