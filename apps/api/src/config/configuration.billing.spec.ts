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
