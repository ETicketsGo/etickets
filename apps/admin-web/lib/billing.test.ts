import { describe, expect, it } from 'vitest';
import { ALL_ENTITLEMENT_KEYS } from '@eticketsgo/shared-types';
import {
  ADJUSTMENT_KIND_WORDS,
  BILLING_COPY,
  ENTITLEMENT_SOURCE_WORDS,
  INTERVAL_WORDS,
  LEDGER_REASON_WORDS,
  PLAN_WORDS,
  SUBSCRIPTION_SOURCE_WORDS,
  SUBSCRIPTION_STATUS_WORDS,
  bpsText,
  endOfDayIso,
  entitlementLabel,
  entitlementValueText,
  majorToMinor,
  minorToMajorInput,
  percentToBps,
  reasonProblem,
  subscriptionStatusTone,
  subscriptionStatusWords,
  wholeNumber,
} from './billing';

describe('subscription states in words', () => {
  it('names every state plainly', () => {
    expect(subscriptionStatusWords('TRIALING')).toBe('Trial');
    expect(subscriptionStatusWords('ACTIVE')).toBe('Active');
    expect(subscriptionStatusWords('PAST_DUE')).toBe('Payment failed');
    expect(subscriptionStatusWords('GRACE')).toBe('Grace period');
    expect(subscriptionStatusWords('CANCELLED')).toBe('Cancelled');
    expect(subscriptionStatusWords('EXPIRED')).toBe('Ended');
    expect(subscriptionStatusWords('COMPLIMENTARY')).toBe('Free of charge');
    expect(subscriptionStatusWords(null)).toBe('No subscription');
  });

  it('marks a failed payment as an error', () => {
    expect(subscriptionStatusTone('PAST_DUE')).toBe('error');
    expect(subscriptionStatusTone('ACTIVE')).toBe('success');
    expect(subscriptionStatusTone('UNKNOWN')).toBe('neutral');
  });
});

describe('amounts typed in major units', () => {
  it('converts INR and USD by 100, as text not floats', () => {
    expect(majorToMinor('999', 'INR')).toBe(99900);
    expect(majorToMinor('999', 'USD')).toBe(99900);
    expect(majorToMinor('19', 'USD')).toBe(1900);
    expect(majorToMinor('19.5', 'USD')).toBe(1950);
    expect(majorToMinor('19.99', 'USD')).toBe(1999);
    expect(majorToMinor('0.29', 'USD')).toBe(29);
    expect(majorToMinor('1,999', 'INR')).toBe(199900);
    expect(majorToMinor('0', 'INR')).toBe(0);
  });

  it('refuses what is not a plain amount', () => {
    expect(majorToMinor('', 'INR')).toBeNull();
    expect(majorToMinor('-5', 'INR')).toBeNull();
    expect(majorToMinor('1.999', 'USD')).toBeNull();
    expect(majorToMinor('abc', 'USD')).toBeNull();
    expect(majorToMinor('1e3', 'USD')).toBeNull();
  });

  it('uses the currency own decimals', () => {
    expect(majorToMinor('500', 'JPY')).toBe(500);
    expect(majorToMinor('500.5', 'JPY')).toBeNull();
  });

  it('turns minor units back into what a person types', () => {
    expect(minorToMajorInput(99900, 'INR')).toBe('999');
    expect(minorToMajorInput(1950, 'USD')).toBe('19.50');
    expect(minorToMajorInput(5, 'USD')).toBe('0.05');
    expect(majorToMinor(minorToMajorInput(1999, 'USD'), 'USD')).toBe(1999);
  });
});

describe('percent off as basis points', () => {
  it('multiplies by 100', () => {
    expect(percentToBps('10')).toBe(1000);
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100')).toBe(10000);
    expect(bpsText(1250)).toBe('12.5%');
  });

  it('refuses zero, more than 100 and too many decimals', () => {
    expect(percentToBps('0')).toBeNull();
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('1.234')).toBeNull();
    expect(percentToBps('')).toBeNull();
  });
});

describe('small helpers', () => {
  it('reads whole numbers and reasons', () => {
    expect(wholeNumber('30')).toBe(30);
    expect(wholeNumber('3.5')).toBeNull();
    expect(reasonProblem('ok')).toBeDefined();
    expect(reasonProblem('  Pilot partner  ')).toBeUndefined();
    expect(endOfDayIso('2026-11-30')).toBe('2026-11-30T23:59:59.000Z');
    expect(endOfDayIso('')).toBeNull();
  });

  it('names every entitlement and shows values plainly', () => {
    for (const key of ALL_ENTITLEMENT_KEYS) expect(entitlementLabel(key)).not.toBe(key);
    expect(
      entitlementValueText({
        key: 'campaigns.monthly_email_quota',
        boolValue: null,
        intValue: 2000,
      }),
    ).toBe('2,000');
    expect(entitlementValueText({ key: 'audience.basic', boolValue: true, intValue: null })).toBe(
      'On',
    );
  });
});

describe('copy', () => {
  it('is plain ASCII everywhere', () => {
    const all = [
      ...Object.values(SUBSCRIPTION_STATUS_WORDS),
      ...Object.values(SUBSCRIPTION_SOURCE_WORDS),
      ...Object.values(ENTITLEMENT_SOURCE_WORDS),
      ...Object.values(LEDGER_REASON_WORDS),
      ...Object.values(ADJUSTMENT_KIND_WORDS),
      ...Object.values(INTERVAL_WORDS),
      ...Object.values(PLAN_WORDS),
      ...Object.values(BILLING_COPY),
      ...ALL_ENTITLEMENT_KEYS.map(entitlementLabel),
    ];
    for (const text of all) expect(text).toMatch(/^[\x20-\x7E]*$/);
  });
});
