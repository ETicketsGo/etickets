import { OrganizationsService } from './organizations.service';

/**
 * The legal-identity review, through the service: every route that writes the identity, the
 * independent reviewer, and what approval does to bank accounts verified under the old one.
 */
const OWNER = { id: 'owner-1', email: 'owner@example.test', fullName: 'Owner', roles: [] } as never;
const STAFF_A = { id: 'staff-a', email: 'a@eticketsgo.test', fullName: 'A', roles: [] } as never;
const STAFF_B = { id: 'staff-b', email: 'b@eticketsgo.test', fullName: 'B', roles: [] } as never;

const APPROVED_COMPANY = {
  id: 'org-1',
  status: 'APPROVED',
  legalName: 'DeepTrics Software Solutions Pvt Ltd',
  legalEntityType: 'Private limited company',
  registeredCountry: 'India',
  taxRegistrationKind: 'Not GST registered',
  taxRegistrationNumber: null,
  legalIdentityStatus: 'APPROVED',
  approvedLegalName: 'DeepTrics Software Solutions Pvt Ltd',
  approvedLegalEntityType: 'Private limited company',
  approvedRegisteredCountry: 'India',
  approvedTaxRegistrationKind: 'Not GST registered',
  approvedTaxRegistrationNumber: null,
  legalIdentityApprovedAt: new Date('2026-11-09T23:09:36Z'),
  legalIdentityApprovedByUserId: 'super-1',
  legalIdentityChangedAt: null,
  legalIdentityChangedByUserId: null,
  legalIdentityReviewNote: null,
};

function setup(org: Record<string, unknown>, opts: { member?: boolean } = {}) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const verifiedAccount = {
    id: 'acct-1',
    organizationId: 'org-1',
    currency: 'INR',
    holderName: 'Srinivasa Rao M',
    bankName: 'State Bank of India',
    bankCode: 'SBIN0013328',
    accountLast4: '6284',
    verifiedAt: new Date('2026-11-09T23:16:48Z'),
    version: 1,
  };
  const prisma: Record<string, unknown> = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(org),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...org, ...data })),
    },
    organizationMember: { count: jest.fn().mockResolvedValue(opts.member ? 1 : 0) },
    organizerPayoutAccount: {
      findMany: jest.fn().mockResolvedValue([verifiedAccount]),
      update: jest.fn(async () => ({ ...verifiedAccount, verifiedAt: null, version: 2 })),
    },
    organizerPayoutAccountVersion: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const service = new OrganizationsService(
    prisma as never,
    access as never,
    audit as never,
    { send: jest.fn() } as never,
    { get: () => undefined } as never,
  );
  return { service, prisma: prisma as Record<string, Record<string, jest.Mock>>, audit };
}

describe('changing an approved legal identity', () => {
  it('a company switching to "Individual" goes to review, and says which fields changed', async () => {
    const { service, prisma, audit } = setup(APPROVED_COMPANY);
    await service.updateLegalIdentity(OWNER, 'org-1', {
      legalName: 'Srinivasa Rao M',
      legalEntityType: 'Individual',
    } as never);
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legalName: 'Srinivasa Rao M',
          legalEntityType: 'Individual',
          legalIdentityStatus: 'PENDING_REVIEW',
          legalIdentityChangedByUserId: 'owner-1',
        }),
      }),
    );
    // The approved snapshot is NOT touched by the edit: it stays the company.
    const data = prisma.organization.update.mock.calls[0][0].data;
    expect(data.approvedLegalName).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          identityReview: expect.objectContaining({
            status: 'PENDING_REVIEW',
            changedCriticalFields: ['legalName', 'legalEntityType'],
          }),
        }),
      }),
    );
  });

  it('staff entering the change on the organizer’s behalf go through the same review', async () => {
    const { service, prisma } = setup(APPROVED_COMPANY);
    await service.adminUpdateLegalIdentity(STAFF_A, 'org-1', {
      legalEntityType: 'Individual',
    } as never);
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legalIdentityStatus: 'PENDING_REVIEW',
          legalIdentityChangedByUserId: 'staff-a',
        }),
      }),
    );
  });

  it('a contact or address change does not touch the identity review', async () => {
    const { service, prisma } = setup(APPROVED_COMPANY);
    await service.updateLegalIdentity(OWNER, 'org-1', { registeredCity: 'Hyderabad' } as never);
    const data = prisma.organization.update.mock.calls[0][0].data;
    expect(data.legalIdentityStatus).toBeUndefined();
  });
});

describe('reviewing a changed identity', () => {
  const PENDING = {
    ...APPROVED_COMPANY,
    legalName: 'Srinivasa Rao M',
    legalEntityType: 'Individual',
    legalIdentityStatus: 'PENDING_REVIEW',
    legalIdentityChangedByUserId: 'staff-a',
  };

  it('whoever made the change may not approve it', async () => {
    const { service, prisma, audit } = setup(PENDING);
    await expect(
      service.reviewLegalIdentity(STAFF_A, 'org-1', { decision: 'APPROVE' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/someone else/) });
    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORGANIZATION_LEGAL_IDENTITY_REVIEW_REFUSED',
        metadata: expect.objectContaining({ reasonCode: 'SAME_PERSON' }),
      }),
    );
  });

  it('a member of the organization may not approve it', async () => {
    const { service, prisma } = setup(PENDING, { member: true });
    await expect(
      service.reviewLegalIdentity(STAFF_B, 'org-1', { decision: 'APPROVE' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/belong to this organization/) });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('independent approval writes the new snapshot and sends the bank account back for verification', async () => {
    const { service, prisma, audit } = setup(PENDING);
    const r = await service.reviewLegalIdentity(STAFF_B, 'org-1', {
      decision: 'APPROVE',
      note: 'ok',
    });
    expect(r).toEqual({ status: 'APPROVED', bankAccountsToReverify: ['acct-1'] });
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legalIdentityStatus: 'APPROVED',
          approvedLegalName: 'Srinivasa Rao M',
          approvedLegalEntityType: 'Individual',
          legalIdentityApprovedByUserId: 'staff-b',
        }),
      }),
    );
    // Verified under the old identity -> unverified, as a NEW version saved by the reviewer
    // (so the reviewer cannot also verify it); the old version stays in history.
    expect(prisma.organizerPayoutAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verifiedAt: null,
          updatedByUserId: 'staff-b',
          version: { increment: 1 },
        }),
      }),
    );
    expect(prisma.organizerPayoutAccountVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changedFields: ['legalIdentity'],
          savedByUserId: 'staff-b',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYOUT_ACCOUNT_REVERIFICATION_REQUIRED',
        entityId: 'acct-1',
      }),
    );
  });

  it('a tax-number-only change approves without sending the bank account back', async () => {
    const { service, prisma } = setup({
      ...APPROVED_COMPANY,
      taxRegistrationNumber: '36AAAAA0000A1Z5',
      legalIdentityStatus: 'PENDING_REVIEW',
      legalIdentityChangedByUserId: 'owner-1',
    });
    const r = await service.reviewLegalIdentity(STAFF_B, 'org-1', { decision: 'APPROVE' });
    expect(r.bankAccountsToReverify).toEqual([]);
    expect(prisma.organizerPayoutAccount.update).not.toHaveBeenCalled();
  });

  it('asking for changes keeps payouts on hold and leaves the bank account alone', async () => {
    const { service, prisma } = setup(PENDING);
    const r = await service.reviewLegalIdentity(STAFF_B, 'org-1', {
      decision: 'REQUEST_CHANGES',
      note: 'A private limited company is paid into its own current account.',
    });
    expect(r.status).toBe('CHANGES_REQUESTED');
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ legalIdentityStatus: 'CHANGES_REQUESTED' }),
      }),
    );
    expect(prisma.organizerPayoutAccount.update).not.toHaveBeenCalled();
  });

  it('there must be a change waiting', async () => {
    const { service } = setup(APPROVED_COMPANY);
    await expect(
      service.reviewLegalIdentity(STAFF_B, 'org-1', { decision: 'APPROVE' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/no legal-identity change/) });
  });
});
