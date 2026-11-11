import {
  PayoutsService,
  payoutHoldMessage,
  payoutOwnerFacts,
  type PayoutHoldReason,
} from './payouts.service';

/*
  The admin payout list says why an open payout is held, before anyone clicks "Mark paid", from
  the same rule and in the same words `markPaid` refuses with. Prisma is faked; the rule itself
  (payoutDestinationVerdict) has its own tests.
*/
const COMPANY = {
  legalIdentityStatus: 'APPROVED',
  approvedLegalName: 'Acme Events Private Limited',
  approvedLegalEntityType: 'Private Limited Company',
  legalName: 'Acme Events Private Limited',
  legalEntityType: 'Private Limited Company',
};
const verified = { verifiedAt: new Date(), rejectedAt: null };

function payout(id: string, organizationId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organizationId,
    currency: 'INR',
    netMinor: 99800,
    status: 'PENDING',
    organization: { name: organizationId },
    ...over,
  };
}

function service(
  rows: {
    payouts: ReturnType<typeof payout>[];
    accounts: Record<string, unknown>[];
    orgs: Record<string, unknown>[];
    memberOf?: string[];
  },
  mode?: 'on',
) {
  const calls = { accounts: 0, orgs: 0 };
  const prisma = {
    payout: { findMany: async () => rows.payouts },
    organizerPayoutAccount: {
      findMany: async () => {
        calls.accounts++;
        return rows.accounts;
      },
    },
    organization: {
      findMany: async () => {
        calls.orgs++;
        return rows.orgs;
      },
    },
    organizationMember: {
      findMany: async () => (rows.memberOf ?? []).map((organizationId) => ({ organizationId })),
    },
  };
  const svc = new PayoutsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    { get: (k: string) => (k === 'SOLE_OPERATOR_MODE' ? mode : undefined) } as never,
  );
  return { svc, calls };
}

describe('admin payout list: why an open payout is held', () => {
  it('names each hold in the words markPaid refuses with, and nothing on a payable one', async () => {
    const { svc } = service({
      payouts: [
        payout('ok', 'org-ok'),
        payout('noacct', 'org-noacct'),
        payout('unverified', 'org-unverified'),
        payout('identity', 'org-identity'),
        payout('mismatch', 'org-mismatch'),
      ],
      accounts: [
        {
          organizationId: 'org-ok',
          currency: 'INR',
          holderName: 'Acme Events Pvt Ltd',
          ...verified,
        },
        {
          organizationId: 'org-unverified',
          currency: 'INR',
          holderName: 'Acme Events Pvt Ltd',
          verifiedAt: null,
          rejectedAt: null,
        },
        {
          organizationId: 'org-identity',
          currency: 'INR',
          holderName: 'Acme Events Pvt Ltd',
          ...verified,
        },
        { organizationId: 'org-mismatch', currency: 'INR', holderName: 'Ravi Kumar', ...verified },
      ],
      orgs: [
        { id: 'org-ok', ...COMPANY },
        { id: 'org-noacct', ...COMPANY },
        { id: 'org-unverified', ...COMPANY },
        {
          id: 'org-identity',
          ...COMPANY,
          legalIdentityStatus: 'PENDING_REVIEW',
          legalName: 'Ravi Kumar',
          legalEntityType: 'Individual',
        },
        { id: 'org-mismatch', ...COMPANY },
      ],
    });
    const list = (await svc.adminList()) as Array<{
      id: string;
      hold: { code: string; message: string } | null;
    }>;
    const by = Object.fromEntries(list.map((p) => [p.id, p.hold]));
    expect(by.ok).toBeNull();
    expect(by.noacct?.code).toBe('DESTINATION_NO_ACCOUNT');
    expect(by.unverified?.code).toBe('DESTINATION_PENDING_VERIFICATION');
    // An approved company that renamed itself to match a personal account is still held.
    expect(by.identity?.code).toBe('DESTINATION_IDENTITY_NOT_APPROVED');
    expect(by.mismatch?.code).toBe('DESTINATION_OWNERSHIP_MISMATCH');
    for (const p of list.filter((x) => x.hold)) {
      const reason = p.hold!.code.replace('DESTINATION_', '') as PayoutHoldReason;
      expect(p.hold!.message).toBe(payoutHoldMessage(reason, 'INR'));
    }
  });

  it('judges the account in the payout currency only', async () => {
    const { svc } = service({
      payouts: [payout('usd', 'org-a', { currency: 'USD' })],
      accounts: [
        {
          organizationId: 'org-a',
          currency: 'INR',
          holderName: 'Acme Events Pvt Ltd',
          ...verified,
        },
      ],
      orgs: [{ id: 'org-a', ...COMPANY }],
    });
    const [p] = (await svc.adminList()) as Array<{ hold: { code: string } | null }>;
    expect(p.hold?.code).toBe('DESTINATION_NO_ACCOUNT');
  });

  it('paid, failed and zero payouts carry no hold, and a list with nothing open reads nothing else', async () => {
    const { svc, calls } = service({
      payouts: [
        payout('paid', 'org-a', { status: 'PAID' }),
        payout('failed', 'org-a', { status: 'FAILED' }),
      ],
      accounts: [],
      orgs: [],
    });
    const list = (await svc.adminList()) as Array<{ hold: unknown }>;
    expect(list.every((p) => p.hold === null)).toBe(true);
    expect(calls).toEqual({ accounts: 0, orgs: 0 });

    const zero = service({
      payouts: [payout('zero', 'org-a', { netMinor: 0 })],
      accounts: [],
      orgs: [{ id: 'org-a', ...COMPANY }],
    });
    const [z] = (await zero.svc.adminList()) as Array<{ hold: unknown }>;
    expect(z.hold).toBeNull();
  });
});

describe('admin payout list: an account the viewer verified (founder-operated payouts)', () => {
  const OLD = new Date(Date.now() - 49 * 60 * 60 * 1000);
  const founder = { id: 'founder', roles: ['ADMIN', 'SUPER_ADMIN'] } as never;
  const ready = {
    organizationId: 'org-a',
    currency: 'INR',
    holderName: 'Acme Events Pvt Ltd',
    version: 2,
    verifiedAt: OLD,
    rejectedAt: null,
    verifiedByUserId: 'founder',
    ownerConfirmedAt: OLD,
    ownerConfirmedVersion: 2,
    verificationMethod: 'PENNY_DROP',
    verificationEvidence: 'PD-1',
  };
  const list = async (
    account: Record<string, unknown>,
    mode?: 'on',
    viewer = founder,
    memberOf: string[] = [],
  ) => {
    const { svc } = service(
      {
        payouts: [payout('p', 'org-a')],
        accounts: [account],
        orgs: [{ id: 'org-a', ...COMPANY }],
        memberOf,
      },
      mode,
    );
    const [p] = (await svc.adminList(viewer)) as Array<{
      hold: { code: string; message: string; unmet?: string[] } | null;
    }>;
    return p.hold;
  };

  it('all conditions met: no hold, so Mark paid shows (the dialog asks the rest)', async () => {
    expect(await list(ready, 'on')).toBeNull();
  });

  it('switch off: held for the verifier, payable for anyone else', async () => {
    expect((await list(ready))?.unmet).toEqual(['MODE_OFF']);
    expect(await list(ready, undefined, { id: 'other', roles: ['ADMIN'] } as never)).toBeNull();
  });

  it('names each unmet condition: confirmation, evidence, 48 hours, membership', async () => {
    const h = await list(
      { ...ready, ownerConfirmedVersion: 1, verificationEvidence: null, verifiedAt: new Date() },
      'on',
    );
    expect(h?.code).toBe('VERIFIER_CANNOT_PAY');
    expect(h?.unmet).toEqual([
      'NOT_CONFIRMED_BY_ORGANIZER',
      'NO_VERIFICATION_EVIDENCE',
      'WAITING_PERIOD',
    ]);
    expect(h?.message).toMatch(/has not confirmed/);
    expect((await list(ready, 'on', founder, ['org-a']))?.unmet).toEqual(['ORGANIZATION_MEMBER']);
  });

  it('a destination hold still wins (bank or identity first)', async () => {
    expect((await list({ ...ready, disputedAt: OLD }, 'on'))?.code).toBe('DESTINATION_DISPUTED');
  });
});

describe('payoutOwnerFacts (shared with markPaid)', () => {
  it('holds on a change waiting for review or refused; uses the approved snapshot once approved', () => {
    expect(payoutOwnerFacts({ ...COMPANY, legalIdentityStatus: 'PENDING_REVIEW' })?.approved).toBe(
      false,
    );
    expect(
      payoutOwnerFacts({ ...COMPANY, legalIdentityStatus: 'CHANGES_REQUESTED' })?.approved,
    ).toBe(false);
    expect(
      payoutOwnerFacts({ ...COMPANY, legalName: 'Edited Name', legalEntityType: 'Individual' }),
    ).toEqual({
      approved: true,
      legalName: COMPANY.approvedLegalName,
      legalEntityType: COMPANY.approvedLegalEntityType,
    });
    // UNREVIEWED (seeds and fixtures only) is judged on the identity on file.
    expect(
      payoutOwnerFacts({ ...COMPANY, legalIdentityStatus: 'UNREVIEWED', legalName: 'On File' })
        ?.legalName,
    ).toBe('On File');
    expect(payoutOwnerFacts(null)).toBeNull();
  });
});
