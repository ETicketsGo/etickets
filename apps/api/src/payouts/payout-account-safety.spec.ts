import {
  changedFieldsOf,
  independenceFailure,
  looksLikeAccountNumber,
  payoutDestinationVerdict,
  reviewStatusOf,
} from './payout-account-safety';

describe('reviewStatusOf', () => {
  const at = new Date();
  it('is pending until somebody decides', () => {
    expect(reviewStatusOf({ verifiedAt: null, rejectedAt: null })).toBe('PENDING_VERIFICATION');
  });
  it('is verified or rejected once decided', () => {
    expect(reviewStatusOf({ verifiedAt: at, rejectedAt: null })).toBe('VERIFIED');
    expect(reviewStatusOf({ verifiedAt: null, rejectedAt: at })).toBe('REJECTED');
  });
});

describe('changedFieldsOf', () => {
  const prev = { holderName: 'A', bankName: 'B', bankCode: 'C' };
  it('calls a first save initial', () => {
    expect(changedFieldsOf(null, prev, true)).toBe('initial');
  });
  it('names exactly the fields that differ, number last', () => {
    expect(changedFieldsOf(prev, { ...prev, bankCode: 'D', holderName: 'Z' }, true)).toEqual([
      'holderName',
      'bankCode',
      'accountNumber',
    ]);
  });
  it('is empty when nothing changed', () => {
    expect(changedFieldsOf(prev, prev, false)).toEqual([]);
  });
});

describe('looksLikeAccountNumber', () => {
  it.each(['501001234567', '5010 0123 4567', '5010-0123-4567', 'call about 123456 today'])(
    'catches %s',
    (text) => {
      expect(looksLikeAccountNumber(text)).toBe(true);
    },
  );
  it.each(['Name does not match', 'ticket 12345', 'checked on 2026-10-11 by phone', ''])(
    'allows %s',
    (text) => {
      expect(looksLikeAccountNumber(text)).toBe(false);
    },
  );
});

describe('independenceFailure (maker-checker)', () => {
  it('refuses the person who saved it', () => {
    expect(
      independenceFailure({ actorUserId: 'u1', savedByUserId: 'u1', actorIsMember: false }),
    ).toBe('SAME_PERSON');
  });
  it('refuses a member of the organization', () => {
    expect(
      independenceFailure({ actorUserId: 'u2', savedByUserId: 'u1', actorIsMember: true }),
    ).toBe('ORGANIZATION_MEMBER');
  });
  it('allows somebody else outside the organization', () => {
    expect(
      independenceFailure({ actorUserId: 'u2', savedByUserId: 'u1', actorIsMember: false }),
    ).toBeNull();
  });
  it('still applies the membership rule when the maker is unknown (legacy rows)', () => {
    expect(
      independenceFailure({ actorUserId: 'u2', savedByUserId: null, actorIsMember: true }),
    ).toBe('ORGANIZATION_MEMBER');
    expect(
      independenceFailure({ actorUserId: 'u2', savedByUserId: null, actorIsMember: false }),
    ).toBeNull();
  });
});

describe('payoutDestinationVerdict (the hold)', () => {
  const at = new Date();
  it('allows a payout into a verified account', () => {
    expect(
      payoutDestinationVerdict({ netMinor: 100, account: { verifiedAt: at, rejectedAt: null } }),
    ).toEqual({ allowed: true });
  });
  it.each([
    ['no account', null, 'NO_ACCOUNT'],
    ['a pending account', { verifiedAt: null, rejectedAt: null }, 'PENDING_VERIFICATION'],
    ['a rejected account', { verifiedAt: null, rejectedAt: at }, 'REJECTED'],
  ] as const)('holds a payout with %s', (_name, account, reason) => {
    expect(payoutDestinationVerdict({ netMinor: 100, account })).toEqual({
      allowed: false,
      reason,
    });
  });
  it('never holds a payout that sends nothing to the organizer', () => {
    expect(payoutDestinationVerdict({ netMinor: 0, account: null })).toEqual({ allowed: true });
    expect(payoutDestinationVerdict({ netMinor: -1, account: null })).toEqual({ allowed: true });
  });
});
