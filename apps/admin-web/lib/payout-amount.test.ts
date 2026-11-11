import { describe, expect, it } from 'vitest';
import { typedAmountToMinor, verifiedByViewer } from './payout-amount';

describe('typedAmountToMinor', () => {
  it('reads plain amounts with up to two decimals', () => {
    expect(typedAmountToMinor('500')).toBe(50000);
    expect(typedAmountToMinor('500.5')).toBe(50050);
    expect(typedAmountToMinor('1,200.05')).toBe(120005);
    expect(typedAmountToMinor(' 0.01 ')).toBe(1);
  });

  it('refuses anything that is not a plain amount', () => {
    for (const bad of ['', 'abc', '-5', '12.345', '1.2.3', '5e2']) {
      expect(typedAmountToMinor(bad)).toBeNull();
    }
  });
});

describe('verifiedByViewer', () => {
  const accounts = [
    { organization: { id: 'org1' }, currency: 'INR', verifiedBy: { id: 'me' } },
    { organization: { id: 'org1' }, currency: 'USD', verifiedBy: { id: 'other' } },
  ];
  it('is true only for the account in the payout currency that the viewer verified', () => {
    expect(verifiedByViewer(accounts, { organizationId: 'org1', currency: 'INR' }, 'me')).toBe(
      true,
    );
    expect(verifiedByViewer(accounts, { organizationId: 'org1', currency: 'USD' }, 'me')).toBe(
      false,
    );
    expect(verifiedByViewer(accounts, { organizationId: 'org2', currency: 'INR' }, 'me')).toBe(
      false,
    );
    expect(verifiedByViewer(accounts, { organizationId: 'org1', currency: 'INR' }, undefined)).toBe(
      false,
    );
  });
});
