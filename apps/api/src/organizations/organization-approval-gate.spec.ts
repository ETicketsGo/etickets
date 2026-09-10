import { OrganizationsService } from './organizations.service';

/**
 * What has to be true before an organization may take money from the public.
 *
 * ── THE GAP ────────────────────────────────────────────────────────────────────────
 * A new organization is PENDING and cannot sell a ticket until a human approves it, which is
 * the gate that matters and it was already there. But the human was approving on a name and
 * an email address: the legal identity fields had existed since the tax work and nothing
 * ever required them, so an organization could reach APPROVED having declared nothing about
 * who it actually is.
 *
 * The first person who needs that is whoever has to trace a payout, or answer a customer
 * asking who charged them — by which point the organization is selling.
 */

const COMPLETE = {
  id: 'org-1',
  name: 'DeepTrics',
  legalName: 'DeepTrics Entertainment Private Limited',
  taxRegistrationKind: 'GSTIN',
  taxRegistrationNumber: '36AABCU9603R1ZM',
};

const admin = { id: 'admin-1', roles: ['ADMIN'], email: 'a@b.test' } as never;

/** A service with just enough around it to exercise `review`. */
function serviceFor(org: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const notified: string[] = [];
  const prisma = {
    organization: {
      findUnique: async () => org,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...org, ...data };
      },
    },
  } as never;
  const audit = { record: async (e: Record<string, unknown>) => void audits.push(e) } as never;
  const audience = {
    notifyOrganizationOwners: async (_id: string, type: string) => void notified.push(type),
  } as never;

  const service = new OrganizationsService(prisma, {} as never, audit, audience, {
    get: () => undefined,
  } as never);
  return { service, updates, audits, notified };
}

describe('approving an organization', () => {
  it('refuses when no legal identity has been declared', async () => {
    const { service, updates } = serviceFor({ id: 'org-1', name: 'Anonymous Promotions' });

    await expect(service.review(admin, 'org-1', { decision: 'APPROVE' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Nothing was written: a refused approval must not half-approve.
    expect(updates).toEqual([]);
  });

  it('names every missing field, so the reviewer can ask for all of them at once', async () => {
    const { service } = serviceFor({ id: 'org-1', name: 'Anonymous Promotions' });
    await expect(service.review(admin, 'org-1', { decision: 'APPROVE' })).rejects.toMatchObject({
      details: {
        missing: ['legal name', 'tax registration type', 'tax registration number'],
      },
    });
  });

  it('refuses on a partial declaration too', async () => {
    const { service } = serviceFor({ ...COMPLETE, taxRegistrationNumber: null });
    await expect(service.review(admin, 'org-1', { decision: 'APPROVE' })).rejects.toBeDefined();
  });

  it('approves when the declaration is complete', async () => {
    const { service, updates, notified } = serviceFor(COMPLETE);
    await service.review(admin, 'org-1', { decision: 'APPROVE' });
    expect(updates).toEqual([{ status: 'APPROVED' }]);
    expect(notified).toEqual(['ORGANIZATION_APPROVED']);
  });

  /*
    ── REJECTION IS NOT GATED, AND MUST NOT BE ─────────────────────────────────────────
    An organization that never filled its details in is the common case for rejection. A
    check that blocked BOTH decisions would leave exactly the registrations a reviewer most
    wants gone stuck in the queue forever.
  */
  it('rejects an organization with no legal identity, because that is the usual reason', async () => {
    const { service, updates, notified } = serviceFor({ id: 'org-1', name: 'Spam Inc' });
    await service.review(admin, 'org-1', { decision: 'REJECT', note: 'No identity supplied.' });
    expect(updates).toEqual([{ status: 'REJECTED' }]);
    expect(notified).toEqual(['ORGANIZATION_REJECTED']);
  });
});

describe('the override', () => {
  /*
    An absolute requirement with no way past it strands the honest case nobody thought of —
    a market whose registration type is not encoded, paperwork in a different form. So the
    gate holds by default and a reviewer can step over it by saying so, on the record.
  */
  it('lets a reviewer approve anyway, with a written reason', async () => {
    const { service, updates } = serviceFor({ id: 'org-1', name: 'Village Arts Trust' });
    await service.review(admin, 'org-1', {
      decision: 'APPROVE',
      overrideIdentityCheck: { reason: 'Verified the trust deed by email with the registrar.' },
    });
    expect(updates).toEqual([{ status: 'APPROVED' }]);
  });

  it('records the override, the reason and what was missing on the approval itself', async () => {
    const { service, audits } = serviceFor({ id: 'org-1', name: 'Village Arts Trust' });
    await service.review(admin, 'org-1', {
      decision: 'APPROVE',
      overrideIdentityCheck: { reason: 'Verified the trust deed by email with the registrar.' },
    });
    const approval = audits.find((a) => a.action === 'ORGANIZATION_APPROVED');
    expect(approval).toBeDefined();
    /*
      On the approval entry rather than a separate one: the row that says "approved" is the
      same row that says it was approved without a declared identity, and why. Two entries
      could be read apart.
    */
    expect(approval!.metadata).toMatchObject({
      identityCheckOverridden: true,
      overrideReason: 'Verified the trust deed by email with the registrar.',
      missingAtApproval: ['legal name', 'tax registration type', 'tax registration number'],
    });
  });

  it('leaves no override marks on an ordinary approval', async () => {
    // Otherwise every approval would look like one somebody had to reach past a check for.
    const { service, audits } = serviceFor(COMPLETE);
    await service.review(admin, 'org-1', { decision: 'APPROVE' });
    const approval = audits.find((a) => a.action === 'ORGANIZATION_APPROVED');
    expect(approval!.metadata).not.toHaveProperty('identityCheckOverridden');
  });
});
