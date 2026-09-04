import { OrganizationsService } from './organizations.service';
import { AppException } from '../common/errors';

/**
 * A platform administrator recording an organizer's tax registration.
 *
 * ── WHY THIS IS NOT JUST A WIDER ROLE CHECK ────────────────────────────────────────
 * The organizer's owner could already do this. The obvious change was to add ADMIN to the
 * existing guard, and it would have been wrong in a way that only surfaces later: the audit
 * entry would say who acted but not on whose authority, and "the owner recorded their GSTIN"
 * and "the platform recorded a GSTIN on the organizer's behalf" are different facts about a
 * number printed on a tax invoice. When a number turns out to be wrong, which of the two it
 * was decides whose mistake it is.
 *
 * So the admin path records its own action, and the tests below pin that distinction rather
 * than only checking that the write happened.
 */
const ADMIN = { id: 'admin-1', email: 'ops@eticketsgo.test', fullName: 'Ops', roles: [] } as never;

const ORG = {
  legalName: 'Old Name Pvt Ltd',
  taxRegistrationKind: 'GSTIN',
  taxRegistrationNumber: '36AAAAA0000A1Z5',
  registeredAddressLine1: '1 Road',
  registeredAddressLine2: null,
  registeredCity: 'Hyderabad',
  registeredRegion: 'Telangana',
  registeredPostalCode: '500081',
  registeredCountry: 'India',
  financeContactName: 'Fin',
  financeContactEmail: 'fin@example.test',
  financeContactPhone: null,
};

function setup(org: Record<string, unknown> | null = ORG) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(org),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...org, ...data })),
    },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const service = new OrganizationsService(
    prisma as never,
    access as never,
    audit as never,
    { send: jest.fn() } as never,
    { get: () => undefined } as never,
  );
  return { service, prisma, audit, access };
}

describe('an admin recording a registration on an organizer’s behalf', () => {
  it('writes the number', async () => {
    const { service, prisma } = setup();
    await service.adminUpdateLegalIdentity(ADMIN, 'org-1', {
      taxRegistrationNumber: '36BBBBB1111B2Z6',
    } as never);
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { taxRegistrationNumber: '36BBBBB1111B2Z6' } }),
    );
  });

  it('records a DIFFERENT action from the owner doing it themselves', async () => {
    /*
      The distinction the whole method exists for. Read back later, the log has to say on
      whose authority a number on a tax invoice was entered — and it cannot be inferred from
      the actor's role at read time, because roles change.
    */
    const { service, audit } = setup();
    await service.adminUpdateLegalIdentity(ADMIN, 'org-1', {
      taxRegistrationNumber: 'X',
    } as never);
    const entry = audit.record.mock.calls[0][0];
    expect(entry.action).toBe('ORGANIZATION_LEGAL_IDENTITY_UPDATED_BY_ADMIN');
    expect(entry.actorUserId).toBe('admin-1');
    expect(entry.metadata.onBehalfOf).toBe('org-1');
  });

  it('keeps the old number in the log beside the new one', async () => {
    // Documents already issued keep the values they were issued with. This pair is what
    // lets somebody explain why two invoices name the seller differently.
    const { service, audit } = setup();
    await service.adminUpdateLegalIdentity(ADMIN, 'org-1', {
      taxRegistrationNumber: '36BBBBB1111B2Z6',
    } as never);
    const meta = audit.record.mock.calls[0][0].metadata;
    expect(meta.previousTaxRegistrationNumber).toBe('36AAAAA0000A1Z5');
    expect(meta.newTaxRegistrationNumber).toBe('36BBBBB1111B2Z6');
  });

  it('does NOT require the admin to be a member of the organization', async () => {
    // The owner path calls assertMember. A platform administrator is not a member of any
    // organizer, so requiring it would make this method unusable by the only people it is for.
    const { service, access } = setup();
    await service.adminUpdateLegalIdentity(ADMIN, 'org-1', { legalName: 'New' } as never);
    expect(access.assertMember).not.toHaveBeenCalled();
  });

  it('clears a field set to empty rather than storing an empty string', async () => {
    /*
      An invoice prints what is on file. An empty string is a value that renders as a blank
      line where a field should be absent; null is the field being absent. The readiness
      check also tests for falsy, so a stored "" would report as present and produce a tax
      invoice naming nobody.
    */
    const { service, prisma } = setup();
    await service.adminUpdateLegalIdentity(ADMIN, 'org-1', { legalName: '' } as never);
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { legalName: null } }),
    );
  });

  it('leaves untouched fields alone rather than blanking them', async () => {
    // The form sends a partial patch. Writing `undefined` through as null would wipe the
    // address every time somebody corrected only the phone number.
    const { service, prisma } = setup();
    await service.adminUpdateLegalIdentity(ADMIN, 'org-1', {
      financeContactPhone: '+91 90000 00000',
      legalName: undefined,
    } as never);
    expect(Object.keys(prisma.organization.update.mock.calls[0][0].data)).toEqual([
      'financeContactPhone',
    ]);
  });

  it('refuses an organization that does not exist', async () => {
    const { service, prisma } = setup(null);
    await expect(
      service.adminUpdateLegalIdentity(ADMIN, 'nope', { legalName: 'X' } as never),
    ).rejects.toBeInstanceOf(AppException);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });
});

describe('what the admin is told about readiness', () => {
  it('reports a complete record as able to issue tax invoices', async () => {
    const { service } = setup();
    const status = await service.adminLegalIdentityStatus('org-1');
    expect(status.canIssueTaxInvoice).toBe(true);
    expect(status.missing).toEqual([]);
  });

  it('names what is missing, so filling in the number alone is not mistaken for done', async () => {
    /*
      The trap this closes. An admin enters a GSTIN, the form saves, and nothing says the
      documents are still plain receipts because the registered address is blank — a receipt
      cannot be reissued as a tax invoice afterwards.
    */
    const { service } = setup({ ...ORG, registeredAddressLine1: null, registeredCity: null });
    const status = await service.adminLegalIdentityStatus('org-1');
    expect(status.canIssueTaxInvoice).toBe(false);
    expect(status.missing).toEqual(['Registered address', 'City']);
  });

  it('is not ready on the address alone when there is no registration number', async () => {
    const { service } = setup({ ...ORG, taxRegistrationNumber: null });
    expect((await service.adminLegalIdentityStatus('org-1')).canIssueTaxInvoice).toBe(false);
  });

  it('treats a whitespace-only registration as no registration', async () => {
    // "   " is what a paste of an empty cell looks like, and it must not turn a receipt into
    // a tax invoice naming a registration that is not one.
    const { service } = setup({ ...ORG, taxRegistrationNumber: '   ' });
    expect((await service.adminLegalIdentityStatus('org-1')).canIssueTaxInvoice).toBe(false);
  });
});
