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
    ['PRODUCTION', 'true', 'disabled', /refused in PRODUCTION without BILLING_LIVE_ENABLED=true/],
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

  describe('production live billing (BILLING_LIVE_ENABLED + BILLING_LIVE_MARKETS)', () => {
    const US_LIVE = {
      STRIPE_BILLING_SECRET_KEY: 'sk_live_SECRETVALUE',
      STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_live',
    };
    const IN_LIVE = {
      RAZORPAY_BILLING_KEY_ID: 'rzp_live_KEYID',
      RAZORPAY_BILLING_KEY_SECRET: 'rzpsecretVALUE',
      RAZORPAY_BILLING_WEBHOOK_SECRET: 'rzpwebhookVALUE',
      // GST tax invoice seller facts: TEST values (format-valid, not a real registration).
      BILLING_SELLER_GSTIN_IN: '36TESTA0000T1ZO',
      BILLING_SELLER_SAC_IN: '990000',
      BILLING_SELLER_ADDRESS_IN: 'TEST ONLY, 1 Test Street, Hyderabad 500001',
      PLATFORM_TAX_REGION: 'Telangana',
    };
    const prod = (extra: Record<string, string> = {}) =>
      billingConfigurationErrors({
        APP_ENV: 'PRODUCTION',
        BILLING_ENABLED: 'true',
        BILLING_PROVIDER: 'providers',
        BILLING_LIVE_ENABLED: 'true',
        ...extra,
      }).join('\n');

    it('US only: opens with the dedicated live Stripe billing key and whsec_ secret', () => {
      expect(prod({ BILLING_LIVE_MARKETS: 'US', ...US_LIVE })).toBe('');
    });

    it('IN only: opens with the live Razorpay billing key id, secret and webhook secret', () => {
      expect(prod({ BILLING_LIVE_MARKETS: 'IN', ...IN_LIVE })).toBe('');
    });

    it('both markets, listed in any case and spacing', () => {
      expect(prod({ BILLING_LIVE_MARKETS: ' us , IN ', ...US_LIVE, ...IN_LIVE })).toBe('');
    });

    it('the ticket Stripe key never stands in for the billing key in PRODUCTION', () => {
      const out = prod({
        BILLING_LIVE_MARKETS: 'US',
        STRIPE_SECRET_KEY: 'sk_live_TICKET',
        STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_live',
      });
      expect(out).toMatch(/STRIPE_BILLING_SECRET_KEY is not set/);
      expect(out).not.toContain('sk_live_TICKET');
    });

    it('the ticket Razorpay key and secret never stand in for the billing ones', () => {
      const out = prod({
        BILLING_LIVE_MARKETS: 'IN',
        RAZORPAY_KEY_ID: 'rzp_live_TICKET',
        RAZORPAY_KEY_SECRET: 'ticketsecret',
        RAZORPAY_BILLING_WEBHOOK_SECRET: 'w',
      });
      expect(out).toMatch(/RAZORPAY_BILLING_KEY_ID is not set/);
      expect(out).toMatch(/RAZORPAY_BILLING_KEY_SECRET is not set/);
    });

    it('refuses billing in PRODUCTION without the master switch', () => {
      expect(prod({ BILLING_LIVE_ENABLED: 'false', ...US_LIVE })).toMatch(
        /BILLING_LIVE_ENABLED=true/,
      );
      expect(
        billingConfigurationErrors({
          APP_ENV: 'PRODUCTION',
          BILLING_ENABLED: 'false',
          BILLING_PROVIDER: 'providers',
          ...US_LIVE,
        }).join('\n'),
      ).toMatch(/BILLING_PROVIDER=providers is refused in PRODUCTION/);
    });

    it('refuses the master switch with no markets listed', () => {
      expect(prod({ ...US_LIVE })).toMatch(/BILLING_LIVE_MARKETS lists no market/);
    });

    it('refuses an unknown market', () => {
      expect(prod({ BILLING_LIVE_MARKETS: 'US,CA', ...US_LIVE })).toMatch(
        /BILLING_LIVE_MARKETS names CA/,
      );
    });

    it('refuses the master switch without the real providers', () => {
      expect(
        prod({ BILLING_PROVIDER: 'disabled', BILLING_LIVE_MARKETS: 'US', ...US_LIVE }),
      ).toMatch(/BILLING_LIVE_ENABLED=true needs BILLING_PROVIDER=providers/);
    });

    it('refuses a listed market whose credentials are missing, naming the variable only', () => {
      const out = prod({ BILLING_LIVE_MARKETS: 'US,IN', ...US_LIVE });
      expect(out).toMatch(/RAZORPAY_BILLING_KEY_ID is not set/);
      expect(out).toMatch(/RAZORPAY_BILLING_KEY_SECRET is not set/);
      expect(out).toMatch(/RAZORPAY_BILLING_WEBHOOK_SECRET is not set/);
      expect(prod({ BILLING_LIVE_MARKETS: 'US', STRIPE_BILLING_SECRET_KEY: 'sk_live_x' })).toMatch(
        /STRIPE_BILLING_WEBHOOK_SECRET is not set/,
      );
    });

    it('refuses test credentials in PRODUCTION, never echoing them', () => {
      const us = prod({
        BILLING_LIVE_MARKETS: 'US',
        ...US_LIVE,
        STRIPE_BILLING_SECRET_KEY: 'sk_test_SECRETVALUE',
      });
      expect(us).toMatch(/STRIPE_BILLING_SECRET_KEY is not a LIVE key/);
      expect(us).not.toContain('SECRETVALUE');
      expect(
        prod({ BILLING_LIVE_MARKETS: 'IN', ...IN_LIVE, RAZORPAY_BILLING_KEY_ID: 'rzp_test_x' }),
      ).toMatch(/RAZORPAY_BILLING_KEY_ID is not a LIVE key/);
      // An unlisted market's test key is still a test key in PRODUCTION.
      expect(
        prod({ BILLING_LIVE_MARKETS: 'US', ...US_LIVE, RAZORPAY_BILLING_KEY_ID: 'rzp_test_x' }),
      ).toMatch(/RAZORPAY_BILLING_KEY_ID is not a LIVE key/);
    });

    it('refuses a Stripe billing webhook secret that is not whsec_', () => {
      expect(
        prod({ BILLING_LIVE_MARKETS: 'US', ...US_LIVE, STRIPE_BILLING_WEBHOOK_SECRET: 'nope' }),
      ).toMatch(/STRIPE_BILLING_WEBHOOK_SECRET is not a Stripe webhook signing secret/);
    });

    it('refuses secret references for live billing (the prefix could not be checked)', () => {
      expect(
        prod({
          BILLING_LIVE_MARKETS: 'US',
          ...US_LIVE,
          STRIPE_BILLING_SECRET_KEY_REF: 'billing/stripe/live/secret-key',
        }),
      ).toMatch(/STRIPE_BILLING_SECRET_KEY_REF is refused in PRODUCTION/);
    });

    it('refuses live billing outside PRODUCTION; QA test keys are unchanged', () => {
      for (const env of ['QA', 'LOCAL', 'DEV', 'UAT', 'STAGING']) {
        expect(
          billingConfigurationErrors({
            APP_ENV: env,
            BILLING_ENABLED: 'false',
            BILLING_PROVIDER: 'disabled',
            BILLING_LIVE_ENABLED: 'true',
          }).join('\n'),
        ).toMatch(new RegExp(`BILLING_LIVE_ENABLED=true is refused in ${env}`));
      }
      expect(
        billingConfigurationErrors({
          APP_ENV: 'QA',
          BILLING_ENABLED: 'true',
          BILLING_PROVIDER: 'providers',
          BILLING_LIVE_MARKETS: 'US',
          STRIPE_SECRET_KEY: 'sk_test_x',
          STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
        }).join('\n'),
      ).toMatch(/BILLING_LIVE_MARKETS is refused in QA/);
      expect(
        billingConfigurationErrors({
          APP_ENV: 'QA',
          BILLING_ENABLED: 'true',
          BILLING_PROVIDER: 'providers',
          STRIPE_SECRET_KEY: 'sk_test_x',
          STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
          RAZORPAY_KEY_ID: 'rzp_test_x',
          RAZORPAY_KEY_SECRET: 's',
          RAZORPAY_BILLING_WEBHOOK_SECRET: 'w',
        }),
      ).toEqual([]);
      // Live keys are still refused in QA.
      expect(
        billingConfigurationErrors({
          APP_ENV: 'QA',
          BILLING_ENABLED: 'true',
          BILLING_PROVIDER: 'providers',
          ...US_LIVE,
        }).join('\n'),
      ).toMatch(/LIVE key/);
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
