import {
  validatePaymentConfig,
  type ProviderConfigView,
  type RouteView,
} from './payment-config.validator';
import type { PaymentEnvName } from './payment-environment';

const realStripe = (over: Partial<ProviderConfigView> = {}): ProviderConfigView => ({
  provider: 'stripe',
  enabled: true,
  mode: 'LIVE',
  publicKey: 'pk_live_abc123',
  secretKeyRef: 'payments/stripe/production/secret-key',
  webhookSecretRef: 'payments/stripe/production/webhook-secret',
  ...over,
});

const catchAll = (provider: string): RouteView => ({
  country: '*',
  currency: '*',
  method: '*',
  provider,
  active: true,
});

function run(env: PaymentEnvName, providers: ProviderConfigView[], routes: RouteView[]) {
  return validatePaymentConfig({ env, providers, routes });
}

describe('validatePaymentConfig — fail closed', () => {
  it('accepts a well-formed production config', () => {
    const res = run('PRODUCTION', [realStripe()], [catchAll('stripe')]);
    expect(res.ok).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'ERROR')).toHaveLength(0);
  });

  it('rejects an enabled real provider with a placeholder public key', () => {
    const res = run(
      'PRODUCTION',
      [realStripe({ publicKey: 'pk_live_replace_me' })],
      [catchAll('stripe')],
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /placeholder public key/.test(i.message))).toBe(true);
  });

  it('rejects an enabled real provider missing a secret reference', () => {
    const res = run('PRODUCTION', [realStripe({ secretKeyRef: null })], [catchAll('stripe')]);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /secret key reference/.test(i.message))).toBe(true);
  });

  it('rejects the dummy provider enabled outside local/dev/QA', () => {
    const dummy: ProviderConfigView = { provider: 'dummy', enabled: true, mode: 'DUMMY' };
    const res = run('PRODUCTION', [dummy], [catchAll('dummy')]);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /Dummy provider is enabled/.test(i.message))).toBe(true);
  });

  it('allows the dummy provider in LOCAL', () => {
    const dummy: ProviderConfigView = { provider: 'dummy', enabled: true, mode: 'DUMMY' };
    const res = run('LOCAL', [dummy], [catchAll('dummy')]);
    expect(res.ok).toBe(true);
  });

  it('rejects LIVE mode outside staging/production', () => {
    const res = run('QA', [realStripe({ mode: 'LIVE' })], [catchAll('stripe')]);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /LIVE is only permitted/.test(i.message))).toBe(true);
  });

  it('rejects TEST mode in production', () => {
    const res = run(
      'PRODUCTION',
      [realStripe({ mode: 'TEST', publicKey: 'pk_test_abc' })],
      [catchAll('stripe')],
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /still in TEST mode/.test(i.message))).toBe(true);
  });

  it('rejects a route pointing at a provider that is not enabled', () => {
    const res = run('PRODUCTION', [realStripe()], [catchAll('razorpay')]);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /not enabled/.test(i.message))).toBe(true);
  });

  it('fails closed in production with no enabled provider or route', () => {
    const res = run('PRODUCTION', [], []);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /No payment provider is enabled/.test(i.message))).toBe(true);
    expect(res.issues.some((i) => /No active payment route/.test(i.message))).toBe(true);
  });

  it('does not fail closed in LOCAL when config is empty', () => {
    const res = run('LOCAL', [], []);
    expect(res.ok).toBe(true);
  });
});
