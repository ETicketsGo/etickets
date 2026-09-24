import 'reflect-metadata';
import { OrganizationStatus } from '@eticketsgo/shared-types';
import { OrganizationLifecycleService } from './organization-lifecycle.service';
import { organizationReadiness } from './organization-readiness';

/**
 * Suspending an organizer, deleting one, and what they still owe us.
 *
 * ── WHY SUSPENSION IS TESTED AND NOT ONLY THE BUTTON ───────────────────────────────
 * `SUSPENDED` existed in the schema before this and nothing ever wrote it or read it, so a suspend
 * control would have been decorative: the organizer's events stayed on sale. These tests hold the
 * write; `apps/api/src/bookings` holds the read that refuses their checkout.
 *
 * ── AND WHY DELETION MOSTLY REFUSES ────────────────────────────────────────────────
 * Asked for: a way to delete an organizer. Most of the ones somebody wants gone have taken money
 * and issued tickets, and those records are what answer a chargeback months later. The refusal
 * names what is in the way, because "why can I not delete this" is the question worth answering.
 */
const admin = { id: 'admin-1', email: 'admin@example.test' } as never;

function makeService(over: Record<string, unknown> = {}) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'org-1',
        name: 'Aurora Live',
        slug: 'aurora',
        status: 'APPROVED',
      }),
      update: jest.fn().mockResolvedValue({ id: 'org-1', status: 'SUSPENDED' }),
      delete: jest.fn().mockResolvedValue({ id: 'org-1' }),
    },
    booking: { count: jest.fn().mockResolvedValue(0) },
    payout: { count: jest.fn().mockResolvedValue(0) },
    settlement: { count: jest.fn().mockResolvedValue(0) },
    organizerPayoutAccount: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        booking: { count: jest.fn().mockResolvedValue(0) },
        organization: { delete: jest.fn().mockResolvedValue({ id: 'org-1' }) },
      }),
    ),
    ...over,
  };
  return {
    service: new OrganizationLifecycleService(prisma as never, audit as never),
    prisma,
    audit,
  };
}

describe('suspending an organizer', () => {
  it('refuses to suspend without a reason somebody can read later', async () => {
    const { service, prisma } = makeService();

    await expect(service.setSuspended(admin, 'org-1', true, '   ')).rejects.toThrow(
      /Say why you are suspending them/,
    );
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('writes the status and records the reason in the audit log', async () => {
    const { service, prisma, audit } = makeService();

    await service.setSuspended(admin, 'org-1', true, 'Unanswered compliance request');

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { status: OrganizationStatus.SUSPENDED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORGANIZATION_SUSPENDED',
        metadata: { previousStatus: 'APPROVED', reason: 'Unanswered compliance request' },
      }),
    );
  });

  it('reinstates to APPROVED, not back into the review queue', async () => {
    /* A suspension is something the platform did to them; it is not a reason to re-approve. */
    const { service, prisma } = makeService({
      organization: {
        findUnique: jest.fn().mockResolvedValue({ id: 'org-1', name: 'A', status: 'SUSPENDED' }),
        update: jest.fn().mockResolvedValue({ id: 'org-1', status: 'APPROVED' }),
      },
    });

    await service.setSuspended(admin, 'org-1', false);

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { status: OrganizationStatus.APPROVED },
    });
  });

  it('refuses to reinstate an organizer who is not suspended', async () => {
    const { service } = makeService();

    await expect(service.setSuspended(admin, 'org-1', false)).rejects.toThrow(/not suspended/);
  });
});

describe('deleting an organizer', () => {
  it('refuses while any booking exists, of any status, and says what is in the way', async () => {
    const { service } = makeService({
      booking: { count: jest.fn().mockResolvedValue(3) },
      payout: { count: jest.fn().mockResolvedValue(1) },
      settlement: { count: jest.fn().mockResolvedValue(0) },
    });

    await expect(service.remove(admin, 'org-1')).rejects.toThrow(/3 bookings, 1 payout/);
  });

  it('deletes one that never traded, and records it BEFORE the row is gone', async () => {
    const { service, audit } = makeService();

    const result = await service.remove(admin, 'org-1');

    expect(result).toEqual({ deleted: true, name: 'Aurora Live' });
    // Named in the audit entry, because after the delete there is nothing to read a name from.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORGANIZATION_DELETED',
        metadata: expect.objectContaining({ name: 'Aurora Live' }),
      }),
    );
  });

  it('refuses inside the transaction if a booking lands mid-delete', async () => {
    const { service } = makeService({
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          booking: { count: jest.fn().mockResolvedValue(1) },
          organization: { delete: jest.fn() },
        }),
      ),
    });

    await expect(service.remove(admin, 'org-1')).rejects.toThrow(/arrived while this was being/);
  });
});

describe('what an organizer still owes us', () => {
  const full = {
    status: 'APPROVED',
    legalName: 'Aurora Live Pvt Ltd',
    legalEntityType: 'Private limited company',
    registeredCountry: 'India',
    registeredAddressLine1: '1 Road',
    registeredCity: 'Hyderabad',
    taxRegistrationNumber: '36AAAAA0000A1Z5',
    financeContactEmail: 'fin@example.test',
    contactEmail: 'help@example.test',
    grievanceOfficerName: 'Grievance Officer',
    grievanceOfficerEmail: 'complaints@example.test',
    logoUrl: '/logo.png',
    description: 'We put on shows.',
    hasPayoutAccount: true,
    payoutAccountVerified: true,
  };

  it('has nothing to say about an organizer who has given us everything', () => {
    expect(organizationReadiness(full)).toEqual([]);
  });

  it('chases the complaints contact, because somebody outside the platform requires it', () => {
    const items = organizationReadiness({ ...full, grievanceOfficerEmail: '' });

    const item = items.find((i) => i.key === 'grievance-officer');
    expect(item).toMatchObject({ severity: 'IMPORTANT', fixPath: '/organizer/settings' });
    // Says what the gap costs, never "this is required".
    expect(item?.consequence).toMatch(/we cannot pass them on/);
  });

  it('blocks on a missing bank account, because the money genuinely cannot move', () => {
    const items = organizationReadiness({ ...full, hasPayoutAccount: false });

    expect(items.find((i) => i.key === 'payout-account')?.severity).toBe('BLOCKING');
  });

  it('only blocks on a legal identity while the organizer is still unapproved', () => {
    const pending = organizationReadiness({ ...full, status: 'PENDING', legalName: '' });
    const approved = organizationReadiness({ ...full, status: 'APPROVED', legalName: '' });

    expect(pending.find((i) => i.key === 'legal-identity')?.severity).toBe('BLOCKING');
    expect(approved.find((i) => i.key === 'legal-identity')?.severity).toBe('IMPORTANT');
  });

  it('never dresses a profile picture up as a requirement', () => {
    const items = organizationReadiness({ ...full, logoUrl: null, taxRegistrationNumber: null });

    expect(items.find((i) => i.key === 'logo')?.severity).toBe('SUGGESTED');
    // An organizer below the GST threshold cannot register, and sells perfectly well.
    expect(items.find((i) => i.key === 'tax-registration')?.severity).toBe('SUGGESTED');
  });
});
