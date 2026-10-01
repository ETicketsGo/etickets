import { describe, it, expect } from 'vitest';
import {
  connectWords,
  PLATFORM_SETTLEMENTS_OFF,
  hasOrganizerRequirements,
} from './connect-onboarding-words';

/**
 * The rule these tests exist to hold: nothing this card says may name the payment provider, one
 * of its products, a configuration of our platform, or a value out of our database.
 */
const ONBOARDING_STATUSES = [
  'NOT_STARTED',
  'ONBOARDING',
  'PENDING_VERIFICATION',
  'ENABLED',
  'RESTRICTED',
  'DISABLED',
  'REJECTED',
];

/* The enum spellings themselves. An organizer must never meet one. */
const RAW_ENUM = /\b[A-Z]{2,}(_[A-Z]+)*\b/;
/* Provider and platform internals, including the words that caused this change. */
const INTERNALS = /razorpay|stripe|route|connect|acct_|rzp_|linked account|platform/i;

describe('what an organizer is told about their payout account', () => {
  it.each(ONBOARDING_STATUSES)('%s never reaches the screen as itself', (status) => {
    const { label, note } = connectWords(status);
    const said = `${label} ${note ?? ''}`;
    expect(said).not.toMatch(RAW_ENUM);
    expect(said).not.toContain(status);
  });

  it.each(ONBOARDING_STATUSES)('%s names no provider or platform internal', (status) => {
    const { label, note } = connectWords(status);
    expect(`${label} ${note ?? ''}`).not.toMatch(INTERNALS);
  });

  it('gives every known status a distinct label', () => {
    const labels = ONBOARDING_STATUSES.map((s) => connectWords(s).label);
    /*
      Two states that read identically are worse than one state, because the organizer cannot
      tell that anything changed. ONBOARDING and the unknown fallback deliberately share a
      label, which is why this compares the known set only.
    */
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('does not leak a status it has never met', () => {
    const { label, note } = connectWords('SOME_FUTURE_PROVIDER_STATE');
    expect(label).not.toContain('SOME_FUTURE_PROVIDER_STATE');
    expect(label).not.toMatch(RAW_ENUM);
    expect(note).toBeNull();
  });

  it('says nothing is needed while the provider is checking', () => {
    // The organizer has already done their part; a call to action here would be a wasted trip.
    expect(connectWords('PENDING_VERIFICATION').note).toMatch(/nothing is needed from you/i);
  });

  it('adds no note to a ready account', () => {
    expect(connectWords('ENABLED').note).toBeNull();
  });
});

describe('what is said when the platform has not switched settlements on', () => {
  it('names no provider, no product and no platform configuration', () => {
    expect(PLATFORM_SETTLEMENTS_OFF).not.toMatch(INTERNALS);
  });

  it('does not send the organizer to support over our own configuration', () => {
    expect(PLATFORM_SETTLEMENTS_OFF).not.toMatch(/contact support|get in touch|email us/i);
  });

  it('says the organizer has nothing to do, and that selling continues', () => {
    expect(PLATFORM_SETTLEMENTS_OFF).toMatch(/no action is required/i);
    expect(PLATFORM_SETTLEMENTS_OFF).toMatch(/sales are unaffected/i);
  });
});

describe('outstanding requirements', () => {
  const base = {
    organizationId: 'org1',
    provider: 'razorpay' as const,
    hasAccount: true,
    linkedAccountId: null,
    onboardingStatus: 'ONBOARDING',
    chargesEnabled: true,
    payoutsEnabled: false,
    requirementsDue: [],
    routeEnabled: false,
    payoutReady: false,
    country: 'IN',
    currency: 'INR',
  };

  it('is false when the provider is waiting on nothing', () => {
    expect(hasOrganizerRequirements(base)).toBe(false);
  });

  it('is true when the provider still wants something', () => {
    expect(hasOrganizerRequirements({ ...base, requirementsDue: ['individual.pan'] })).toBe(true);
  });
});
