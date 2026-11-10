import {
  approvedIdentity,
  changedCriticalFields,
  currentIdentity,
  identityReviewerFailure,
  identityStatusAfterEdit,
  ownershipBasisChanged,
  type LegalIdentity,
} from './legal-identity-review';

const company: LegalIdentity = {
  legalName: 'DeepTrics Software Solutions Pvt Ltd',
  legalEntityType: 'Private limited company',
  registeredCountry: 'India',
  taxRegistrationKind: 'Not GST registered',
  taxRegistrationNumber: null,
};

describe('identityStatusAfterEdit', () => {
  it('an approved company that becomes an individual goes to review', () => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'APPROVED',
      current: 'APPROVED',
      approved: company,
      next: { ...company, legalName: 'Srinivasa Rao M', legalEntityType: 'Individual' },
    });
    expect(r).toEqual({ status: 'PENDING_REVIEW', changed: ['legalName', 'legalEntityType'] });
  });

  it.each([
    ['registeredCountry', 'United States'],
    ['taxRegistrationKind', 'GSTIN'],
    ['taxRegistrationNumber', '36AAAAA0000A1Z5'],
  ] as const)('a change of %s goes to review', (field, value) => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'APPROVED',
      current: 'APPROVED',
      approved: company,
      next: { ...company, [field]: value },
    });
    expect(r.status).toBe('PENDING_REVIEW');
    expect(r.changed).toEqual([field]);
  });

  it('spacing or case alone is not a change', () => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'APPROVED',
      current: 'APPROVED',
      approved: company,
      next: { ...company, legalName: '  deeptrics   software solutions PVT LTD ' },
    });
    expect(r.status).toBe('APPROVED');
  });

  it('putting every field back to the approved values clears the review', () => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'APPROVED',
      current: 'PENDING_REVIEW',
      approved: company,
      next: company,
    });
    expect(r.status).toBe('APPROVED');
  });

  it('before the organization is approved there is nothing to review yet', () => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'PENDING',
      current: 'UNREVIEWED',
      approved: null,
      next: company,
    });
    expect(r).toEqual({ status: 'UNREVIEWED', changed: [] });
  });

  it('an approved organization with no approved snapshot is always reviewed', () => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'APPROVED',
      current: 'PENDING_REVIEW',
      approved: null,
      next: company,
    });
    expect(r.status).toBe('PENDING_REVIEW');
  });

  it('a suspended organization is held to the same rule', () => {
    const r = identityStatusAfterEdit({
      organizationStatus: 'SUSPENDED',
      current: 'APPROVED',
      approved: company,
      next: { ...company, legalEntityType: 'Individual' },
    });
    expect(r.status).toBe('PENDING_REVIEW');
  });
});

describe('ownershipBasisChanged', () => {
  it('a new name or a new legal form means the bank account is checked again', () => {
    expect(ownershipBasisChanged(company, { ...company, legalName: 'Other Pvt Ltd' })).toBe(true);
    expect(ownershipBasisChanged(company, { ...company, legalEntityType: 'Individual' })).toBe(
      true,
    );
    expect(ownershipBasisChanged(null, company)).toBe(true);
  });

  it('a tax number or country correction does not change whose account it is', () => {
    expect(ownershipBasisChanged(company, { ...company, taxRegistrationNumber: 'X' })).toBe(false);
  });
});

describe('identityReviewerFailure', () => {
  it('the person who made the change may not approve it', () => {
    expect(
      identityReviewerFailure({ actorUserId: 'u1', changedByUserId: 'u1', actorIsMember: false }),
    ).toBe('SAME_PERSON');
  });
  it('a member of the organization may not approve it', () => {
    expect(
      identityReviewerFailure({ actorUserId: 'u2', changedByUserId: 'u1', actorIsMember: true }),
    ).toBe('ORGANIZATION_MEMBER');
  });
  it('independent staff may', () => {
    expect(
      identityReviewerFailure({ actorUserId: 'u2', changedByUserId: 'u1', actorIsMember: false }),
    ).toBeNull();
  });
});

describe('snapshots', () => {
  it('no approval time means no approved identity', () => {
    expect(
      approvedIdentity({
        approvedLegalName: 'X',
        approvedLegalEntityType: null,
        approvedRegisteredCountry: null,
        approvedTaxRegistrationKind: null,
        approvedTaxRegistrationNumber: null,
        legalIdentityApprovedAt: null,
      }),
    ).toBeNull();
  });
  it('lists every field as changed when nothing was ever approved', () => {
    expect(changedCriticalFields(null, currentIdentity(company))).toHaveLength(5);
  });
});
