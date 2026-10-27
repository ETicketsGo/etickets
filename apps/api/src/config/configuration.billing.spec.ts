import { billingConfigurationErrors, loadConfig } from './configuration';

/**
 * Organizer billing cannot be switched on by accident, and its test double never reaches an
 * environment where real money could be expected.
 */
describe('billing configuration', () => {
  const cases: Array<[string, string, string, RegExp | null]> = [
    // env, BILLING_ENABLED, BILLING_PROVIDER, refusal
    ['PRODUCTION', 'false', 'disabled', null],
    ['STAGING', 'false', 'disabled', null],
    ['LOCAL', 'false', 'disabled', null],
    ['LOCAL', 'true', 'mock', null],
    ['DEV', 'true', 'mock', null],
    ['QA', 'true', 'mock', null],
    ['QA', 'false', 'mock', null],
    ['UAT', 'false', 'mock', /test double and is refused in UAT/],
    ['STAGING', 'false', 'mock', /test double and is refused in STAGING/],
    ['PRODUCTION', 'false', 'mock', /test double and is refused in PRODUCTION/],
    ['LOCAL', 'true', 'disabled', /nothing could take a payment/],
    ['PRODUCTION', 'true', 'disabled', /refused in PRODUCTION: no real billing provider/],
    ['STAGING', 'true', 'disabled', /refused in STAGING: no real billing provider/],
  ];

  it.each(cases)('%s BILLING_ENABLED=%s BILLING_PROVIDER=%s', (env, enabled, provider, refusal) => {
    const errors = billingConfigurationErrors({
      APP_ENV: env,
      BILLING_ENABLED: enabled,
      BILLING_PROVIDER: provider,
    });
    if (!refusal) expect(errors).toEqual([]);
    else expect(errors.join('\n')).toMatch(refusal);
  });

  describe('the real providers (BILLING_PROVIDER=providers)', () => {
    const stripeTest = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x' };
    const rzpTest = {
      RAZORPAY_KEY_ID: 'rzp_test_x',
      RAZORPAY_KEY_SECRET: 's',
      RAZORPAY_BILLING_WEBHOOK_SECRET: 'w',
    };
    const errors = (env: string, enabled: string, extra: Record<string, string> = {}) =>
      billingConfigurationErrors({
        APP_ENV: env,
        BILLING_ENABLED: enabled,
        BILLING_PROVIDER: 'providers',
        ...extra,
      }).join('\n');

    it('QA may enable billing on test keys for either provider', () => {
      expect(errors('QA', 'true', stripeTest)).toBe('');
      expect(errors('QA', 'true', rzpTest)).toBe('');
      expect(errors('LOCAL', 'true', { ...stripeTest, ...rzpTest })).toBe('');
    });

    it('STAGING, PRODUCTION and UAT refuse the providers, enabled or not', () => {
      for (const env of ['STAGING', 'PRODUCTION', 'UAT']) {
        expect(errors(env, 'false', stripeTest)).toMatch(/refused in .*test keys/);
      }
      expect(errors('PRODUCTION', 'true', stripeTest)).toMatch(/refused in PRODUCTION/);
    });

    it('refuses a live key, whether billing-specific or the ticket fallback', () => {
      expect(errors('QA', 'true', { ...stripeTest, STRIPE_SECRET_KEY: 'sk_live_x' })).toMatch(
        /LIVE key/,
      );
      expect(errors('QA', 'false', { ...rzpTest, RAZORPAY_BILLING_KEY_ID: 'rzp_live_x' })).toMatch(
        /LIVE key/,
      );
    });

    it('refuses to enable with no provider configured, naming variables only', () => {
      const out = errors('QA', 'true', { STRIPE_SECRET_KEY: 'sk_test_x' });
      expect(out).toMatch(/neither provider is configured/);
      expect(out).toMatch(/STRIPE_BILLING_WEBHOOK_SECRET/);
      expect(out).not.toContain('sk_test_x');
    });

    it('a ticket webhook secret never counts as the billing one', () => {
      expect(
        errors('QA', 'true', { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t' }),
      ).toMatch(/neither provider is configured/);
    });
  });

  describe('at boot', () => {
    const ORIGINAL = process.env;
    const BASE = {
      APP_ENV: 'LOCAL',
      DATABASE_URL: 'postgres://u:p@db/x',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      QR_SIGNING_SECRET: 'c'.repeat(40),
      PAYMENT_WEBHOOK_SECRET: 'd'.repeat(40),
    };
    afterEach(() => {
      process.env = ORIGINAL;
    });

    it('defaults to off with the disabled provider', () => {
      process.env = { ...ORIGINAL, ...BASE };
      delete process.env.BILLING_ENABLED;
      delete process.env.BILLING_PROVIDER;
      const cfg = loadConfig();
      expect(cfg.BILLING_ENABLED).toBe('false');
      expect(cfg.BILLING_PROVIDER).toBe('disabled');
    });

    it('stops the boot on a contradictory state', () => {
      process.env = {
        ...ORIGINAL,
        ...BASE,
        BILLING_ENABLED: 'true',
        BILLING_PROVIDER: 'disabled',
      };
      expect(() => loadConfig()).toThrow(/Unsafe billing configuration/);
    });
  });
});
