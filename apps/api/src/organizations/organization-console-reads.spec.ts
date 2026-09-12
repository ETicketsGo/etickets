import { OrganizationsService } from './organizations.service';

/**
 * Two reads the organizer console is built on.
 *
 * `listMine` says what the caller's role is in each organization, so the console can stop
 * offering owner-only actions (refunds, the team, cash, legal details) to managers and
 * check-in staff who would only be refused. `legalIdentityStatus` seeds the settings form, and
 * has to return every field that form edits — it used to return seven of twelve.
 */
const MEMBER = {
  id: 'user-1',
  email: 'manager@example.test',
  fullName: 'Manager',
  roles: ['ORGANIZER_MANAGER'],
} as never;

const LEGAL = {
  legalName: 'Aurora Live Pvt Ltd',
  taxRegistrationKind: 'GSTIN',
  taxRegistrationNumber: '36AAAAA0000A1Z5',
  registeredAddressLine1: '1 Road',
  registeredAddressLine2: 'Floor 2',
  registeredCity: 'Hyderabad',
  registeredRegion: 'Telangana',
  registeredPostalCode: '500081',
  registeredCountry: 'India',
  financeContactName: 'Fin',
  financeContactEmail: 'fin@example.test',
  financeContactPhone: '+91 98765 43210',
};

function setup({ managedIds }: { managedIds: string[] | null }) {
  const prisma = {
    organization: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'org-a', name: 'A', _count: { members: 2, events: 1, venues: 1 } },
        { id: 'org-b', name: 'B', _count: { members: 1, events: 0, venues: 0 } },
      ]),
      findUnique: jest.fn().mockResolvedValue(LEGAL),
    },
    organizationMember: {
      findMany: jest.fn().mockResolvedValue([
        { organizationId: 'org-a', role: 'ORGANIZER_OWNER' },
        { organizationId: 'org-b', role: 'CHECKIN_STAFF' },
      ]),
    },
  };
  const access = {
    managedOrganizationIds: jest.fn().mockResolvedValue(managedIds),
    assertMember: jest.fn().mockResolvedValue(undefined),
  };
  const service = new OrganizationsService(
    prisma as never,
    access as never,
    { record: jest.fn() } as never,
    { notifyAdmins: jest.fn() } as never,
    { get: () => undefined } as never,
  );
  return { service, prisma, access };
}

describe('the organizations a member can work in', () => {
  it('carries the caller’s own role in each, alongside every existing field', async () => {
    const { service } = setup({ managedIds: ['org-a', 'org-b'] });
    const orgs = await service.listMine(MEMBER);
    expect(orgs).toEqual([
      {
        id: 'org-a',
        name: 'A',
        _count: { members: 2, events: 1, venues: 1 },
        myRole: 'ORGANIZER_OWNER',
      },
      {
        id: 'org-b',
        name: 'B',
        _count: { members: 1, events: 0, venues: 0 },
        myRole: 'CHECKIN_STAFF',
      },
    ]);
  });

  it('reads the role from the caller’s ACTIVE memberships only', async () => {
    const { service, prisma } = setup({ managedIds: ['org-a', 'org-b'] });
    await service.listMine(MEMBER);
    expect(prisma.organizationMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', status: 'ACTIVE' } }),
    );
  });

  it('gives a platform administrator no role, because none limits what they may do', async () => {
    const { service, prisma } = setup({ managedIds: null });
    const orgs = await service.listMine(MEMBER);
    expect(orgs.map((o) => o.myRole)).toEqual([null, null]);
    expect(prisma.organizationMember.findMany).not.toHaveBeenCalled();
  });
});

describe('the legal identity read that seeds the settings form', () => {
  it('returns all twelve editable fields, not only the ones that decide a tax invoice', async () => {
    const { service, prisma } = setup({ managedIds: ['org-a'] });
    const result = await service.legalIdentityStatus(MEMBER, 'org-a');

    const select = prisma.organization.findUnique.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(Object.keys(LEGAL).sort());
    expect(result).toMatchObject({
      registeredAddressLine2: 'Floor 2',
      registeredRegion: 'Telangana',
      registeredPostalCode: '500081',
      financeContactName: 'Fin',
      financeContactPhone: '+91 98765 43210',
      missing: [],
      canIssueTaxInvoice: true,
    });
  });
});
