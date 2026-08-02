import { loadConfig } from './configuration';

/**
 * Deployment-environment ↔ payment-credential agreement (fail-closed, at boot).
 *
 * Complements the DB-backed factory validation: this guards the ENV-VAR binding path, so a
 * *deployment* can neither boot PRODUCTION on sandbox keys (orders that never collect money)
 * nor point QA/UAT at live keys (charging real cards during testing).
 */
describe('loadConfig payment environment key safety', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);

  /** Minimal valid env for a given APP_ENV. NODE_ENV stays development so only the
   *  payment-credential guard is exercised (production hardening has its own suite). */
  const base = (appEnv: string): NodeJS.ProcessEnv => ({
    APP_ENV: appEnv,
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
    CORS_ORIGINS: 'https://app.eticketsgo.com',
  });

  /** A production env that also satisfies the production-hardening guard. */
  const prod = (): NodeJS.ProcessEnv => ({
    ...base('PRODUCTION'),
    NODE_ENV: 'production',
    PAYMENT_PROVIDER_NAME: 'stripe',
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  describe('production refuses sandbox credentials', () => {
    it('rejects a Stripe test secret key', () => {
      process.env = { ...prod(), STRIPE_SECRET_KEY: 'sk_test_abc123' };
      expect(() => loadConfig()).toThrow(/STRIPE_SECRET_KEY is a TEST key/);
    });

    it('rejects a Razorpay test key id', () => {
      process.env = { ...prod(), RAZORPAY_KEY_ID: 'rzp_test_abc123', RAZORPAY_MODE: 'test' };
      expect(() => loadConfig()).toThrow(/RAZORPAY_KEY_ID is a TEST key/);
    });

    it('cannot be overridden by PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV', () => {
      process.env = {
        ...prod(),
        STRIPE_SECRET_KEY: 'sk_test_abc123',
        PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'true',
      };
      expect(() => loadConfig()).toThrow(/STRIPE_SECRET_KEY is a TEST key/);
    });

    it('accepts live credentials', () => {
      process.env = {
        ...prod(),
        STRIPE_SECRET_KEY: 'sk_live_abc123',
        RAZORPAY_KEY_ID: 'rzp_live_abc123',
        RAZORPAY_MODE: 'live',
      };
      expect(() => loadConfig()).not.toThrow();
    });

    it('rejects the dummy gateway as the active provider', () => {
      process.env = { ...prod(), PAYMENT_PROVIDER_NAME: 'mock' };
      expect(() => loadConfig()).toThrow(/PAYMENT_PROVIDER_NAME=mock is not permitted/);
    });
  });

  describe('QA/UAT refuse live credentials', () => {
    it.each(['QA', 'UAT', 'DEV', 'LOCAL'])('rejects a Stripe live key in %s', (appEnv) => {
      process.env = { ...base(appEnv), STRIPE_SECRET_KEY: 'sk_live_abc123' };
      expect(() => loadConfig()).toThrow(/STRIPE_SECRET_KEY is a LIVE key/);
    });

    it.each(['QA', 'UAT'])('rejects a Razorpay live key in %s', (appEnv) => {
      process.env = {
        ...base(appEnv),
        RAZORPAY_KEY_ID: 'rzp_live_abc123',
        RAZORPAY_MODE: 'live',
      };
      expect(() => loadConfig()).toThrow(/RAZORPAY_KEY_ID is a LIVE key/);
    });

    it.each(['QA', 'UAT'])('accepts test credentials in %s', (appEnv) => {
      process.env = {
        ...base(appEnv),
        STRIPE_SECRET_KEY: 'sk_test_abc123',
        RAZORPAY_KEY_ID: 'rzp_test_abc123',
        RAZORPAY_MODE: 'test',
      };
      expect(() => loadConfig()).not.toThrow();
    });

    it('allows a live key only with the explicit controlled override', () => {
      process.env = {
        ...base('UAT'),
        STRIPE_SECRET_KEY: 'sk_live_abc123',
        PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'true',
      };
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it('permits sandbox credentials in STAGING (live rehearsal environment)', () => {
    process.env = {
      ...base('STAGING'),
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      PAYMENT_PROVIDER_NAME: 'stripe',
    };
    expect(() => loadConfig()).not.toThrow();
  });

  it('ignores unclassifiable values (secret-manager references resolved after boot)', () => {
    process.env = {
      ...prod(),
      STRIPE_SECRET_KEY: 'payments/stripe/production/secret-key',
    };
    expect(() => loadConfig()).not.toThrow();
  });

  it('requires the Stripe webhook secret to differ from the generic webhook secret', () => {
    process.env = {
      ...prod(),
      STRIPE_SECRET_KEY: 'sk_live_abc123',
      STRIPE_WEBHOOK_SECRET: STRONG,
    };
    expect(() => loadConfig()).toThrow(/STRIPE_WEBHOOK_SECRET must be DISTINCT/);
  });

  it('leaves an unconfigured gateway alone', () => {
    process.env = base('QA');
    expect(() => loadConfig()).not.toThrow();
  });
});
