import { describe, it, expect } from 'vitest';
import {
  computeMarketplaceSplit,
  computeSettlementPayable,
  canTransitionSettlement,
  isReleasableSettlementStatus,
  mapStripeAccountToOnboardingStatus,
  canReceiveSettlements,
  canSellPaidTickets,
  routeProviderForBooking,
  isCountryConsistent,
} from '@eticketsgo/shared-types';

describe('routeProviderForBooking (server-side provider selection)', () => {
  it('routes USD → stripe, INR → razorpay', () => {
    expect(routeProviderForBooking({ currency: 'USD', country: 'US' })).toBe('stripe');
    expect(routeProviderForBooking({ currency: 'usd' })).toBe('stripe');
    expect(routeProviderForBooking({ currency: 'INR', country: 'India' })).toBe('razorpay');
    expect(routeProviderForBooking({ currency: 'inr' })).toBe('razorpay');
  });
  it('returns null for an unsupported currency (caller rejects)', () => {
    expect(routeProviderForBooking({ currency: 'EUR' })).toBeNull();
    expect(routeProviderForBooking({ currency: 'GBP', country: 'GB' })).toBeNull();
  });
  it('flags a country/currency mismatch (e.g. Razorpay+US, Stripe+India)', () => {
    expect(isCountryConsistent('razorpay', 'IN')).toBe(true);
    expect(isCountryConsistent('razorpay', 'US')).toBe(false);
    expect(isCountryConsistent('stripe', 'India')).toBe(false);
    expect(isCountryConsistent('stripe', '')).toBe(true); // unknown country → currency authoritative
  });
});

describe('computeMarketplaceSplit', () => {
  it('splits a customer-pays charge into organizer net + platform fee', () => {
    // Ticket $100.00 face, customer pays $105.00 (fees on top), organizer bears no fee.
    const r = computeMarketplaceSplit({
      subtotalMinor: 10000,
      organizerFeeMinor: 0,
      discountMinor: 0,
      totalMinor: 10500,
    });
    expect(r.organizerNetMinor).toBe(10000);
    expect(r.platformFeeMinor).toBe(500); // total − organizerNet
    expect(r.totalMinor).toBe(10500);
  });

  it('deducts organizer-borne fees and discounts from the organizer net', () => {
    const r = computeMarketplaceSplit({
      subtotalMinor: 10000,
      organizerFeeMinor: 700, // organizer-pays mode
      discountMinor: 500,
      totalMinor: 10000, // customer pays face value
    });
    expect(r.organizerNetMinor).toBe(8800); // 10000 − 700 − 500
    expect(r.platformFeeMinor).toBe(1200); // 10000 − 8800
  });

  it('never lets organizer net go negative', () => {
    const r = computeMarketplaceSplit({
      subtotalMinor: 1000,
      organizerFeeMinor: 2000,
      discountMinor: 0,
      totalMinor: 1000,
    });
    expect(r.organizerNetMinor).toBe(0);
    expect(r.platformFeeMinor).toBe(1000);
  });

  it('rejects a split where the organizer would be owed more than the customer paid', () => {
    expect(() =>
      computeMarketplaceSplit({
        subtotalMinor: 10000,
        organizerFeeMinor: 0,
        discountMinor: 0,
        totalMinor: 9000, // customer paid less than organizer net — impossible
      }),
    ).toThrow(/platformFee would be negative/);
  });

  it('rejects non-integer minor amounts (no floating point money)', () => {
    expect(() =>
      computeMarketplaceSplit({
        subtotalMinor: 100.5,
        organizerFeeMinor: 0,
        discountMinor: 0,
        totalMinor: 100.5,
      }),
    ).toThrow(/integer/);
  });
});

describe('computeSettlementPayable', () => {
  it('deducts refunds, disputes, prior transfers, then withholds the reserve', () => {
    const r = computeSettlementPayable({
      grossOrganizerNetMinor: 100000,
      refundsMinor: 10000,
      disputesMinor: 5000,
      priorTransferredMinor: 0,
      reserveBps: 1000, // 10%
    });
    expect(r.baseMinor).toBe(85000); // 100000 − 10000 − 5000
    expect(r.reserveMinor).toBe(8500); // 10% of base
    expect(r.payableMinor).toBe(76500);
  });

  it('is idempotent-safe: prior transfers reduce the payable to zero', () => {
    const r = computeSettlementPayable({
      grossOrganizerNetMinor: 50000,
      refundsMinor: 0,
      disputesMinor: 0,
      priorTransferredMinor: 50000,
      reserveBps: 0,
    });
    expect(r.payableMinor).toBe(0);
  });

  it('clamps a net-negative settlement to zero (never a negative transfer)', () => {
    const r = computeSettlementPayable({
      grossOrganizerNetMinor: 10000,
      refundsMinor: 12000,
      disputesMinor: 0,
      priorTransferredMinor: 0,
      reserveBps: 0,
    });
    expect(r.baseMinor).toBe(0);
    expect(r.payableMinor).toBe(0);
  });

  it('reserve of 0 bps withholds nothing', () => {
    const r = computeSettlementPayable({
      grossOrganizerNetMinor: 12345,
      refundsMinor: 0,
      disputesMinor: 0,
      priorTransferredMinor: 0,
      reserveBps: 0,
    });
    expect(r.reserveMinor).toBe(0);
    expect(r.payableMinor).toBe(12345);
  });
});

describe('settlement transitions', () => {
  it('allows the happy-path lifecycle', () => {
    expect(canTransitionSettlement('PENDING', 'HELD')).toBe(true);
    expect(canTransitionSettlement('HELD', 'ELIGIBLE')).toBe(true);
    expect(canTransitionSettlement('ELIGIBLE', 'APPROVED')).toBe(true);
    expect(canTransitionSettlement('APPROVED', 'TRANSFER_PROCESSING')).toBe(true);
    expect(canTransitionSettlement('TRANSFER_PROCESSING', 'TRANSFERRED')).toBe(true);
  });

  it('forbids skipping approval or releasing a held settlement', () => {
    expect(canTransitionSettlement('HELD', 'TRANSFER_PROCESSING')).toBe(false);
    expect(canTransitionSettlement('PENDING', 'TRANSFERRED')).toBe(false);
    expect(canTransitionSettlement('REVERSED', 'APPROVED')).toBe(false);
  });

  it('only APPROVED or FAILED settlements are releasable', () => {
    expect(isReleasableSettlementStatus('APPROVED')).toBe(true);
    expect(isReleasableSettlementStatus('FAILED')).toBe(true);
    expect(isReleasableSettlementStatus('ELIGIBLE')).toBe(false);
    expect(isReleasableSettlementStatus('HELD')).toBe(false);
  });
});

describe('mapStripeAccountToOnboardingStatus', () => {
  const base = {
    hasAccount: true,
    detailsSubmitted: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    requirementsCurrentlyDue: [] as string[],
    disabledReason: null as string | null,
  };

  it('NOT_STARTED when no account exists', () => {
    expect(mapStripeAccountToOnboardingStatus({ ...base, hasAccount: false })).toBe('NOT_STARTED');
  });
  it('ONBOARDING before details are submitted', () => {
    expect(mapStripeAccountToOnboardingStatus(base)).toBe('ONBOARDING');
  });
  it('PENDING_VERIFICATION once details are submitted but not yet enabled', () => {
    expect(mapStripeAccountToOnboardingStatus({ ...base, detailsSubmitted: true })).toBe(
      'PENDING_VERIFICATION',
    );
  });
  it('ENABLED when charges + payouts enabled and nothing due', () => {
    expect(
      mapStripeAccountToOnboardingStatus({
        ...base,
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
      }),
    ).toBe('ENABLED');
  });
  it('RESTRICTED when enabled but requirements are currently due', () => {
    expect(
      mapStripeAccountToOnboardingStatus({
        ...base,
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsCurrentlyDue: ['individual.verification.document'],
      }),
    ).toBe('RESTRICTED');
  });
  it('DISABLED / REJECTED from disabled_reason', () => {
    expect(
      mapStripeAccountToOnboardingStatus({ ...base, disabledReason: 'requirements.past_due' }),
    ).toBe('DISABLED');
    expect(mapStripeAccountToOnboardingStatus({ ...base, disabledReason: 'rejected.fraud' })).toBe(
      'REJECTED',
    );
  });
});

describe('policy gates', () => {
  it('only ENABLED/RESTRICTED organizers may receive settlements', () => {
    expect(canReceiveSettlements('ENABLED')).toBe(true);
    expect(canReceiveSettlements('RESTRICTED')).toBe(true);
    expect(canReceiveSettlements('PENDING_VERIFICATION')).toBe(false);
    expect(canReceiveSettlements('DISABLED')).toBe(false);
  });
  it('paid tickets require charges enabled', () => {
    expect(canSellPaidTickets(true)).toBe(true);
    expect(canSellPaidTickets(false)).toBe(false);
  });
});
