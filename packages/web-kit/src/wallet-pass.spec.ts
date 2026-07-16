import { describe, it, expect } from 'vitest';
import {
  walletPassEligible,
  walletProviderCanIssue,
  resolveWalletProviderStatus,
  type WalletProviderConfig,
} from '@eticketsgo/shared-types';

describe('wallet pass eligibility (projection of a valid ticket)', () => {
  it('is eligible ONLY for an ACTIVE ticket', () => {
    expect(walletPassEligible('ACTIVE')).toBe(true);
    for (const s of [
      'REFUNDED',
      'CANCELLED',
      'VOID',
      'REVOKED',
      'TRANSFERRED',
      'CHECKED_IN',
      'EXPIRED',
    ]) {
      expect(walletPassEligible(s), s).toBe(false);
    }
  });
});

describe('wallet provider config resolution (fail-closed)', () => {
  const base: WalletProviderConfig = {
    enabled: true,
    mode: 'sandbox',
    requiredPresent: true,
    hasSigningMaterial: false,
  };

  it('is unavailable when disabled or missing required config', () => {
    expect(resolveWalletProviderStatus({ ...base, enabled: false })).toBe('unavailable');
    expect(resolveWalletProviderStatus({ ...base, requiredPresent: false })).toBe('unavailable');
  });

  it('is sandbox when enabled + valid + sandbox mode (no signing material needed)', () => {
    expect(resolveWalletProviderStatus({ ...base, mode: 'sandbox' })).toBe('sandbox');
  });

  it('is configured only in production WITH signing material, else unavailable', () => {
    expect(
      resolveWalletProviderStatus({ ...base, mode: 'production', hasSigningMaterial: true }),
    ).toBe('configured');
    // Production without resolvable signing material fails closed.
    expect(
      resolveWalletProviderStatus({ ...base, mode: 'production', hasSigningMaterial: false }),
    ).toBe('unavailable');
  });

  it('can issue only when not unavailable', () => {
    expect(walletProviderCanIssue('unavailable')).toBe(false);
    expect(walletProviderCanIssue('sandbox')).toBe(true);
    expect(walletProviderCanIssue('configured')).toBe(true);
  });
});
