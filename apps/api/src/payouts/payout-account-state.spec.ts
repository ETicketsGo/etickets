import {
  derivePayoutAccountState,
  PayoutAccountStateCode,
  type ConnectAccountFact,
  type PayoutAccountFacts,
} from './payout-account-state';

/**
 * Table-driven, because the value of this model is that one combination of facts always produces
 * the same answer. The cases that matter most are the ones where the honest answer is "nothing
 * for you to do" - those are the ones a hand-written UI gets wrong.
 */
const connect = (over: Partial<ConnectAccountFact> = {}): ConnectAccountFact => ({
  hasAccount: true,
  onboardingStatus: 'ENABLED',
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsDue: [],
  disabledReason: null,
  ...over,
});
const facts = (over: Partial<PayoutAccountFacts> = {}): PayoutAccountFacts => ({
  bankAccounts: [],
  connect: null,
  ...over,
});
const VERIFIED_AT = new Date('2026-09-01T00:00:00.000Z');

describe('derivePayoutAccountState', () => {
  const CASES: {
    name: string;
    facts: PayoutAccountFacts;
    code: PayoutAccountStateCode;
    organizerActionRequired: boolean;
    salesAffected: boolean;
    payouts: 'AVAILABLE' | 'PENDING' | 'UNAVAILABLE';
    basis: string;
  }[] = [
    {
      name: 'nothing on file at all',
      facts: facts(),
      code: PayoutAccountStateCode.NO_ACCOUNT,
      organizerActionRequired: true,
      // Selling is unaffected: the money just has nowhere to go yet.
      salesAffected: false,
      payouts: 'UNAVAILABLE',
      basis: 'NONE',
    },
    {
      name: 'a bank account waiting on ETicketsGo',
      facts: facts({ bankAccounts: [{ currency: 'INR', verifiedAt: null }] }),
      code: PayoutAccountStateCode.UNDER_REVIEW,
      // THE rule: verification is ours to do, so nobody is waiting on the organizer.
      organizerActionRequired: false,
      salesAffected: false,
      // Waiting, not blocked.
      payouts: 'PENDING',
      basis: 'BANK',
    },
    {
      name: 'a verified bank account',
      facts: facts({ bankAccounts: [{ currency: 'INR', verifiedAt: VERIFIED_AT }] }),
      code: PayoutAccountStateCode.VERIFIED,
      organizerActionRequired: false,
      salesAffected: false,
      // The organizer's half is done; nothing yet proves money can leave.
      payouts: 'PENDING',
      basis: 'BANK',
    },
    {
      name: 'one verified account among several',
      facts: facts({
        bankAccounts: [
          { currency: 'INR', verifiedAt: null },
          { currency: 'USD', verifiedAt: VERIFIED_AT },
        ],
      }),
      code: PayoutAccountStateCode.VERIFIED,
      organizerActionRequired: false,
      salesAffected: false,
      payouts: 'PENDING',
      basis: 'BANK',
    },
    {
      name: 'a provider account the provider is still checking',
      facts: facts({
        connect: connect({ onboardingStatus: 'PENDING_VERIFICATION', payoutsEnabled: false }),
      }),
      code: PayoutAccountStateCode.UNDER_REVIEW,
      organizerActionRequired: false,
      salesAffected: false,
      payouts: 'PENDING',
      basis: 'CONNECT',
    },
    {
      name: 'a provider asking for one document',
      facts: facts({
        connect: connect({
          onboardingStatus: 'ONBOARDING',
          payoutsEnabled: false,
          requirementsDue: ['individual.verification.document'],
        }),
      }),
      code: PayoutAccountStateCode.ACTION_REQUIRED,
      organizerActionRequired: true,
      salesAffected: false,
      payouts: 'UNAVAILABLE',
      basis: 'CONNECT',
    },
    {
      name: 'a restricted account with nothing specific asked for',
      facts: facts({
        connect: connect({
          onboardingStatus: 'RESTRICTED',
          chargesEnabled: false,
          payoutsEnabled: false,
          disabledReason: 'requirements.past_due',
        }),
      }),
      code: PayoutAccountStateCode.RESTRICTED,
      organizerActionRequired: true,
      salesAffected: true,
      payouts: 'UNAVAILABLE',
      basis: 'CONNECT',
    },
    {
      name: 'details started and never finished',
      facts: facts({
        connect: connect({
          onboardingStatus: 'ONBOARDING',
          detailsSubmitted: false,
          chargesEnabled: false,
          payoutsEnabled: false,
        }),
      }),
      code: PayoutAccountStateCode.DETAILS_REQUIRED,
      organizerActionRequired: true,
      salesAffected: true,
      payouts: 'UNAVAILABLE',
      basis: 'CONNECT',
    },
    {
      name: 'a fully enabled provider account',
      facts: facts({ connect: connect() }),
      code: PayoutAccountStateCode.PAYOUTS_ENABLED,
      organizerActionRequired: false,
      salesAffected: false,
      payouts: 'AVAILABLE',
      basis: 'CONNECT',
    },
  ];

  for (const c of CASES) {
    it(`${c.name} -> ${c.code}`, () => {
      const state = derivePayoutAccountState(c.facts);
      expect({
        code: state.code,
        basis: state.basis,
        organizerActionRequired: state.organizerActionRequired,
        salesAffected: state.salesAffected,
        payouts: state.payouts,
      }).toEqual({
        code: c.code,
        basis: c.basis,
        organizerActionRequired: c.organizerActionRequired,
        salesAffected: c.salesAffected,
        payouts: c.payouts,
      });
    });
  }

  it('never offers an action when it says none is required', () => {
    // A CTA beside "no action is required from you" is the contradiction this model prevents.
    for (const c of CASES) {
      const state = derivePayoutAccountState(c.facts);
      if (!state.organizerActionRequired) expect(state.action).toBeNull();
      else expect(state.action).not.toBeNull();
    }
  });

  it('says so in words when the wait is ours', () => {
    const state = derivePayoutAccountState(
      facts({ bankAccounts: [{ currency: 'INR', verifiedAt: null }] }),
    );
    expect(state.explanation).toContain('No action is required from you right now');
  });

  it('does not treat stopped payouts and stopped sales as the same thing', () => {
    /*
      A provider can pay out and refuse charges, or charge and hold payouts. Collapsing the two
      tells an organizer their event cannot sell when it can, or the reverse.
    */
    const cannotCharge = derivePayoutAccountState(
      facts({
        connect: connect({
          chargesEnabled: false,
          payoutsEnabled: true,
          onboardingStatus: 'PENDING_VERIFICATION',
        }),
      }),
    );
    expect(cannotCharge.salesAffected).toBe(true);
    expect(cannotCharge.payouts).toBe('AVAILABLE');

    const cannotPayOut = derivePayoutAccountState(
      facts({
        connect: connect({
          chargesEnabled: true,
          payoutsEnabled: false,
          onboardingStatus: 'PENDING_VERIFICATION',
        }),
      }),
    );
    expect(cannotPayOut.salesAffected).toBe(false);
    // Waiting on the provider's check, which is PENDING rather than blocked.
    expect(cannotPayOut.payouts).toBe('PENDING');
  });

  it('VERIFIED reports payouts as PENDING, never AVAILABLE', () => {
    /*
      The defect this three-value type replaced. `payoutsAffected: false` on VERIFIED made the
      payout page print "Receiving payouts: Available" for a state whose own description says
      nothing yet proves money can leave. Waiting and working are different facts.
    */
    const state = derivePayoutAccountState(
      facts({ bankAccounts: [{ currency: 'INR', verifiedAt: VERIFIED_AT }] }),
    );
    expect(state.code).toBe(PayoutAccountStateCode.VERIFIED);
    expect(state.payouts).toBe('PENDING');
    expect(state.payouts).not.toBe('AVAILABLE');
  });

  it('VERIFIED and PAYOUTS_ENABLED are not the same state', () => {
    const verified = derivePayoutAccountState(
      facts({ bankAccounts: [{ currency: 'INR', verifiedAt: VERIFIED_AT }] }),
    );
    const enabled = derivePayoutAccountState(facts({ connect: connect() }));
    expect(verified.code).not.toBe(enabled.code);
    expect(verified.payouts).not.toBe(enabled.payouts);
    expect(enabled.payouts).toBe('AVAILABLE');
  });

  it('says payouts are AVAILABLE only where the provider proves it', () => {
    // Every other state must be PENDING or UNAVAILABLE - never a promise nothing supports.
    for (const c of CASES) {
      const state = derivePayoutAccountState(c.facts);
      if (state.payouts === 'AVAILABLE') {
        expect(state.code).toBe(PayoutAccountStateCode.PAYOUTS_ENABLED);
      }
    }
  });

  it('does not call a verified bank account payouts-enabled', () => {
    /*
      A checked bank account is the organizer's half. Whether the platform can actually settle to
      it is a separate fact this function is not given, so it must not be claimed.
    */
    const state = derivePayoutAccountState(
      facts({ bankAccounts: [{ currency: 'INR', verifiedAt: VERIFIED_AT }] }),
    );
    expect(state.code).toBe(PayoutAccountStateCode.VERIFIED);
    expect(state.code).not.toBe(PayoutAccountStateCode.PAYOUTS_ENABLED);
  });

  it('distinguishes no account from an account under review', () => {
    const none = derivePayoutAccountState(facts());
    const waiting = derivePayoutAccountState(
      facts({ bankAccounts: [{ currency: 'INR', verifiedAt: null }] }),
    );
    expect(none.code).not.toBe(waiting.code);
    // And they disagree about who is waiting, which is the whole point.
    expect(none.organizerActionRequired).toBe(true);
    expect(waiting.organizerActionRequired).toBe(false);
  });

  it('a provider requirement outranks a restriction, because it can actually be acted on', () => {
    const state = derivePayoutAccountState(
      facts({
        connect: connect({
          onboardingStatus: 'RESTRICTED',
          chargesEnabled: false,
          payoutsEnabled: false,
          requirementsDue: ['company.tax_id', 'individual.verification.document'],
          disabledReason: 'requirements.past_due',
        }),
      }),
    );
    expect(state.code).toBe(PayoutAccountStateCode.ACTION_REQUIRED);
    expect(state.outstandingRequirements).toBe(2);
  });

  it('leaks no provider-internal text or requirement codes', () => {
    /*
      `disabledReason` is written for an operator and `requirementsDue` holds provider identifiers.
      An organizer gets a count and a sentence; the raw values stay in admin surfaces and logs.
    */
    const state = derivePayoutAccountState(
      facts({
        connect: connect({
          onboardingStatus: 'RESTRICTED',
          chargesEnabled: false,
          payoutsEnabled: false,
          requirementsDue: ['individual.verification.document', 'company.tax_id'],
          disabledReason: 'requirements.past_due',
        }),
      }),
    );
    const rendered = JSON.stringify(state);
    expect(rendered).not.toContain('requirements.past_due');
    expect(rendered).not.toContain('individual.verification.document');
    expect(rendered).not.toContain('company.tax_id');
  });

  it('ignores a connect record that exists but holds no provider account', () => {
    // `hasAccount` is false until the provider has actually issued one; the bank route decides.
    const state = derivePayoutAccountState(
      facts({
        bankAccounts: [{ currency: 'INR', verifiedAt: VERIFIED_AT }],
        connect: connect({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false }),
      }),
    );
    expect(state.basis).toBe('BANK');
    expect(state.code).toBe(PayoutAccountStateCode.VERIFIED);
  });
});
