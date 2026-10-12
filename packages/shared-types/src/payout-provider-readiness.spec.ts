import { describe, expect, it } from 'vitest';
import {
  bankVerification,
  buildProviderEntries,
  razorpayReadiness,
  stripeReadiness,
  summarizeProviderEntries,
  type RazorpayReadinessFacts,
  type StripeReadinessFacts,
} from './payout-provider-readiness';

const stripe = (o: Partial<StripeReadinessFacts> = {}): StripeReadinessFacts => ({
  hasAccount: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  canSellPaidTickets: true,
  ...o,
});
const razorpay = (o: Partial<RazorpayReadinessFacts> = {}): RazorpayReadinessFacts => ({
  hasAccount: true,
  payoutsEnabled: true,
  routeEnabled: true,
  payoutReady: true,
  ...o,
});

describe('Stripe readiness (the dollar sales gate)', () => {
  const cases: [string, Partial<StripeReadinessFacts>, string, string, string][] = [
    [
      'no account',
      {
        hasAccount: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        canSellPaidTickets: false,
      },
      'NO_ACCOUNT',
      'BLOCKED',
      'UNAVAILABLE',
    ],
    [
      'account, charges off',
      { chargesEnabled: false, payoutsEnabled: false, canSellPaidTickets: false },
      'SETUP_UNFINISHED',
      'BLOCKED',
      'UNAVAILABLE',
    ],
    [
      'charges on, payouts not yet',
      { payoutsEnabled: false },
      'PAYOUTS_NOT_ACTIVE',
      'ACCEPTING',
      'PENDING',
    ],
    ['all on', {}, 'ACTIVE', 'ACCEPTING', 'AVAILABLE'],
    [
      'payouts work while charges are off: still cannot sell',
      { chargesEnabled: false, canSellPaidTickets: false },
      'SETUP_UNFINISHED',
      'BLOCKED',
      'AVAILABLE',
    ],
  ];
  it.each(cases)('%s', (_n, over, stage, accepting, payouts) => {
    const r = stripeReadiness(stripe(over));
    expect([r.stage, r.accepting, r.payouts]).toEqual([stage, accepting, payouts]);
  });
});

describe('Razorpay readiness (never gates sales)', () => {
  const cases: [string, Partial<RazorpayReadinessFacts>, string, string][] = [
    [
      'platform Route off',
      { routeEnabled: false, payoutReady: false },
      'PLATFORM_PAYOUTS_OFF',
      'PENDING',
    ],
    [
      'route on, no linked account',
      { hasAccount: false, payoutsEnabled: false, payoutReady: false },
      'LINK_ACCOUNT',
      'UNAVAILABLE',
    ],
    [
      'linked, payouts not enabled',
      { payoutsEnabled: false, payoutReady: false },
      'PAYOUTS_PENDING',
      'PENDING',
    ],
    ['ready', {}, 'ACTIVE', 'AVAILABLE'],
  ];
  it.each(cases)('%s', (_n, over, stage, payouts) => {
    const r = razorpayReadiness(razorpay(over));
    expect([r.stage, r.accepting, r.payouts]).toEqual([stage, 'NOT_GATED', payouts]);
  });
});

describe('bank verification', () => {
  const now = new Date();
  it('is NONE, UNDER_REVIEW, VERIFIED or REJECTED, verified winning', () => {
    expect(bankVerification([])).toBe('NONE');
    expect(bankVerification([{ currency: 'INR', verifiedAt: null }])).toBe('UNDER_REVIEW');
    expect(bankVerification([{ currency: 'INR', verifiedAt: null, rejectedAt: now }])).toBe(
      'REJECTED',
    );
    expect(
      bankVerification([
        { currency: 'INR', verifiedAt: null, rejectedAt: now },
        { currency: 'INR', verifiedAt: now },
      ]),
    ).toBe('VERIFIED');
  });
});

describe('buildProviderEntries', () => {
  const both = { card: true, inr: true };
  it('lists only markets in use; neither gives an empty list and NONE', () => {
    const none = buildProviderEntries({ markets: { card: false, inr: false }, bankAccounts: [] });
    expect(none).toEqual([]);
    expect(summarizeProviderEntries(none)).toEqual({ level: 'NONE', decidedBy: null });
    expect(
      buildProviderEntries({ markets: { card: true, inr: false }, bankAccounts: [] }).map(
        (e) => e.provider,
      ),
    ).toEqual(['STRIPE']);
    expect(
      buildProviderEntries({ markets: { card: false, inr: true }, bankAccounts: [] }).map(
        (e) => e.provider,
      ),
    ).toEqual(['RAZORPAY']);
  });

  it('puts blocked sales first, whatever order the facts arrive in', () => {
    const entries = buildProviderEntries({
      markets: both,
      stripe: stripe({ chargesEnabled: false, canSellPaidTickets: false }),
      razorpay: razorpay(),
      bankAccounts: [],
    });
    expect(entries.map((e) => e.provider)).toEqual(['STRIPE', 'RAZORPAY']);
    expect(summarizeProviderEntries(entries)).toEqual({ level: 'ACTION', decidedBy: 'STRIPE' });
  });

  it('puts a Razorpay problem first when Stripe is healthy', () => {
    const entries = buildProviderEntries({
      markets: both,
      stripe: stripe(),
      razorpay: razorpay({ hasAccount: false, payoutReady: false, payoutsEnabled: false }),
      bankAccounts: [],
    });
    expect(entries.map((e) => e.provider)).toEqual(['RAZORPAY', 'STRIPE']);
    expect(summarizeProviderEntries(entries).decidedBy).toBe('RAZORPAY');
  });

  it('breaks ties Stripe first, deterministically', () => {
    const a = buildProviderEntries({
      markets: both,
      stripe: stripe(),
      razorpay: razorpay(),
      bankAccounts: [],
    });
    expect(a.map((e) => e.provider)).toEqual(['STRIPE', 'RAZORPAY']);
    expect(summarizeProviderEntries(a).level).toBe('READY');
  });

  it('a Razorpay row never makes a rupee market look blocked, and Stripe never leaks into rupees', () => {
    const [e] = buildProviderEntries({
      markets: { card: false, inr: true },
      stripe: stripe({ hasAccount: false, chargesEnabled: false, canSellPaidTickets: false }),
      razorpay: razorpay({ routeEnabled: false, payoutReady: false }),
      bankAccounts: [],
    });
    expect(e.accepting).toBe('NOT_GATED');
    expect(summarizeProviderEntries([e]).level).toBe('WAITING');
  });

  it('attaches bank verification by the market currency', () => {
    const entries = buildProviderEntries({
      markets: both,
      stripe: stripe(),
      razorpay: razorpay(),
      bankAccounts: [{ currency: 'inr', verifiedAt: null }],
    });
    expect(entries.find((e) => e.provider === 'RAZORPAY')?.bank).toBe('UNDER_REVIEW');
    expect(entries.find((e) => e.provider === 'STRIPE')?.bank).toBeNull();
  });
});
