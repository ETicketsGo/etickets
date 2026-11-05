import { describe, expect, it } from 'vitest';
import { paymentConfigEnv } from './payment-config-env';

describe('paymentConfigEnv', () => {
  it("opens on the deployment's own environment, not LOCAL", () => {
    expect(paymentConfigEnv(null, { env: 'UAT', activeEnv: 'UAT' })).toBe('UAT');
    expect(paymentConfigEnv(null, { activeEnv: 'PRODUCTION' })).toBe('PRODUCTION');
  });

  it("keeps the admin's choice once they pick another environment", () => {
    expect(paymentConfigEnv('QA', { env: 'UAT', activeEnv: 'UAT' })).toBe('QA');
  });

  it('shows LOCAL only before the first answer arrives', () => {
    expect(paymentConfigEnv(null, undefined)).toBe('LOCAL');
  });
});
