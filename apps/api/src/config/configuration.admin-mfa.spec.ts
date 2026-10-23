import { loadConfig } from './configuration';

/**
 * STAGING and PRODUCTION refuse to boot without MFA_ENCRYPTION_KEY (assertAdminMfaArmed).
 *
 * Unset, the key leaves admin MFA dormant: MfaService only warns, and every administrator signs
 * in with a password alone. That is the right state for bringing QA up and the wrong state for
 * the tier that holds real customers' money, and nothing looked wrong while it was in it.
 */
describe('loadConfig admin MFA arming', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);
  const KEY = Buffer.alloc(32, 7).toString('base64');

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    APP_ENV: 'PRODUCTION',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
    CORS_ORIGINS: 'https://app.eticketsgo.com',
    PAYMENT_PROVIDER_NAME: 'stripe',
    EMAIL_PROVIDER: 'sendgrid',
    EMAIL_FROM: 'tickets@eticketsgo.com',
    SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio,CA=twilio',
    MFA_ENCRYPTION_KEY: KEY,
    ...extra,
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  it.each(['PRODUCTION', 'STAGING'])('refuses to boot %s without the key', (appEnv) => {
    process.env = env({ APP_ENV: appEnv, MFA_ENCRYPTION_KEY: undefined });
    expect(() => loadConfig()).toThrow(/MFA_ENCRYPTION_KEY is not set/);
  });

  it('treats a blank key as no key', () => {
    process.env = env({ MFA_ENCRYPTION_KEY: '   ' });
    expect(() => loadConfig()).toThrow(/password only/);
  });

  it('boots production with the key set', () => {
    process.env = env();
    expect(loadConfig().MFA_ENCRYPTION_KEY).toBe(KEY);
    expect(loadConfig().MFA_ENROLLMENT).toBe('required');
  });

  it.each(['PRODUCTION', 'STAGING'])(
    'MFA_ENROLLMENT=deferred boots %s without the key (sensitive actions are blocked instead)',
    (appEnv) => {
      process.env = env({
        APP_ENV: appEnv,
        MFA_ENCRYPTION_KEY: undefined,
        MFA_ENROLLMENT: 'deferred',
      });
      expect(loadConfig().MFA_ENROLLMENT).toBe('deferred');
    },
  );

  it('MFA_ENROLLMENT=required is the default and keeps refusing production without the key', () => {
    process.env = env({ MFA_ENCRYPTION_KEY: undefined, MFA_ENROLLMENT: 'required' });
    expect(() => loadConfig()).toThrow(/MFA_ENCRYPTION_KEY is not set/);
  });

  it('refuses an MFA_ENROLLMENT value it does not know rather than guessing', () => {
    process.env = env({ MFA_ENROLLMENT: 'off' });
    expect(() => loadConfig()).toThrow(/MFA_ENROLLMENT/);
  });

  it('a malformed key is still refused in deferred mode: the key is never optional-but-wrong', () => {
    process.env = env({
      MFA_ENROLLMENT: 'deferred',
      MFA_ENCRYPTION_KEY: Buffer.alloc(8, 1).toString('base64'),
    });
    expect(() => loadConfig()).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it.each(['LOCAL', 'DEV', 'QA', 'UAT'])(
    'leaves %s free to run dormant, NODE_ENV=production or not',
    (appEnv) => {
      // QA and UAT run NODE_ENV=production; the rule is keyed on APP_ENV for that reason.
      process.env = env({
        APP_ENV: appEnv,
        MFA_ENCRYPTION_KEY: undefined,
        PAYMENT_PROVIDER_NAME: 'mock',
      });
      expect(() => loadConfig()).not.toThrow(/MFA_ENCRYPTION_KEY/);
    },
  );
});
