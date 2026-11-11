import {
  SOLE_OPERATOR_UNMET_MESSAGES,
  SOLE_OPERATOR_WAIT_MS,
  payoutDestinationVerdict,
  soleOperatorUnmet,
} from './payout-account-safety';

const now = new Date('2026-11-11T12:00:00Z');
const longAgo = new Date(now.getTime() - SOLE_OPERATOR_WAIT_MS - 1000);

const met = {
  modeOn: true,
  actorIsSuperAdmin: true,
  actorIsMember: false,
  account: {
    version: 3,
    verifiedAt: longAgo,
    ownerConfirmedAt: longAgo,
    ownerConfirmedVersion: 3,
    verificationMethod: 'PENNY_DROP',
    verificationEvidence: 'PD-REF',
  },
  reference: 'UTR-1',
  amountConfirmedMinor: 500,
  netMinor: 500,
  attested: true,
  now,
};

describe('soleOperatorUnmet', () => {
  it('applies only when every condition is met', () => {
    expect(soleOperatorUnmet(met)).toEqual([]);
  });

  it('is absolute when the switch is off, for a non super admin, or for a member', () => {
    expect(soleOperatorUnmet({ ...met, modeOn: false })).toEqual(['MODE_OFF']);
    expect(soleOperatorUnmet({ ...met, actorIsSuperAdmin: false })).toEqual(['NOT_SUPER_ADMIN']);
    expect(soleOperatorUnmet({ ...met, actorIsMember: true })).toEqual(['ORGANIZATION_MEMBER']);
  });

  it('needs the organizer to have confirmed THIS version', () => {
    expect(
      soleOperatorUnmet({ ...met, account: { ...met.account, ownerConfirmedVersion: 2 } }),
    ).toEqual(['NOT_CONFIRMED_BY_ORGANIZER']);
    expect(
      soleOperatorUnmet({ ...met, account: { ...met.account, ownerConfirmedAt: null } }),
    ).toEqual(['NOT_CONFIRMED_BY_ORGANIZER']);
  });

  it('needs recorded evidence', () => {
    expect(
      soleOperatorUnmet({ ...met, account: { ...met.account, verificationEvidence: null } }),
    ).toEqual(['NO_VERIFICATION_EVIDENCE']);
  });

  it('needs a full 48 hours since verification', () => {
    const justUnder = new Date(now.getTime() - SOLE_OPERATOR_WAIT_MS + 60_000);
    expect(
      soleOperatorUnmet({ ...met, account: { ...met.account, verifiedAt: justUnder } }),
    ).toEqual(['WAITING_PERIOD']);
    expect(SOLE_OPERATOR_WAIT_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('needs the bank reference, the exact amount and the attestation', () => {
    expect(soleOperatorUnmet({ ...met, reference: null })).toEqual(['BANK_REFERENCE_REQUIRED']);
    expect(soleOperatorUnmet({ ...met, amountConfirmedMinor: undefined })).toEqual([
      'AMOUNT_NOT_CONFIRMED',
    ]);
    expect(soleOperatorUnmet({ ...met, amountConfirmedMinor: 499 })).toEqual([
      'AMOUNT_NOT_CONFIRMED',
    ]);
    expect(soleOperatorUnmet({ ...met, attested: false })).toEqual(['ATTESTATION_REQUIRED']);
  });

  it('has words for every condition', () => {
    for (const message of Object.values(SOLE_OPERATOR_UNMET_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe('payoutDestinationVerdict with a dispute', () => {
  it('holds a disputed account even when it is verified', () => {
    expect(
      payoutDestinationVerdict({
        netMinor: 100,
        account: { verifiedAt: longAgo, rejectedAt: null, disputedAt: now },
      }),
    ).toEqual({ allowed: false, reason: 'DISPUTED' });
  });

  it('a payout that moves no money is not held', () => {
    expect(
      payoutDestinationVerdict({
        netMinor: 0,
        account: { verifiedAt: longAgo, rejectedAt: null, disputedAt: now },
      }),
    ).toEqual({ allowed: true });
  });
});
