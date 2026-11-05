import { loadConfig } from './configuration';

/**
 * SES in a live environment: its own key, its own configuration set, its own topic (R4).
 *
 * The first production audit found production pointed at QA's configuration set, QA's SNS topic
 * and QA's IAM user, with the worker (which sends the mail) holding no key at all. Every one of
 * those boots clean and fails silently: bounces land in the wrong environment, or the key that
 * sends email can also read the payment secrets. These cases pin the boot refusal.
 */
describe('loadConfig: SES production readiness', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);

  const READY = {
    EMAIL_PROVIDER: 'ses',
    EMAIL_FROM: 'tickets@eticketsgo.com',
    AWS_REGION: 'ap-south-1',
    SES_CONFIGURATION_SET: 'eticketsgo-prod',
    SES_AWS_ACCESS_KEY_ID: 'AKIASESONLYEXAMPLE',
    SES_AWS_SECRET_ACCESS_KEY: 'ses-only-secret',
    SES_SNS_TOPIC_ARNS: 'arn:aws:sns:ap-south-1:123456789012:eticketsgo-ses-events-prod',
    SES_WEBHOOK_SECRET: 'w'.repeat(40),
    // The payment secret store's key, which stays exactly as it is.
    AWS_ACCESS_KEY_ID: 'AKIASECRETSEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secrets-secret',
  };

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    APP_ENV: 'PRODUCTION',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    // STAGING/PRODUCTION refuse to boot without the admin MFA key (assertAdminMfaArmed).
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
    CORS_ORIGINS: 'https://app.eticketsgo.com',
    PAYMENT_PROVIDER_NAME: 'stripe',
    SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio,CA=twilio',
    ...READY,
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('boots production with the complete SES configuration', () => {
    process.env = env();
    expect(() => loadConfig()).not.toThrow();
  });

  it.each([
    ['SES_CONFIGURATION_SET', /SES_CONFIGURATION_SET is not set/],
    ['SES_AWS_ACCESS_KEY_ID', /set together/],
    ['SES_AWS_SECRET_ACCESS_KEY', /set together/],
    ['SES_SNS_TOPIC_ARNS', /SES_SNS_TOPIC_ARNS is not set/],
    ['SES_WEBHOOK_SECRET', /SES_WEBHOOK_SECRET must be set/],
    ['AWS_REGION', /AWS_REGION is not set/],
    ['EMAIL_FROM', /EMAIL_FROM/],
  ])('refuses production SES without %s', (name, message) => {
    process.env = env({ [name]: undefined });
    expect(() => loadConfig()).toThrow(message);
  });

  it('refuses production SES with no dedicated key, even with the shared key present', () => {
    process.env = env({ SES_AWS_ACCESS_KEY_ID: undefined, SES_AWS_SECRET_ACCESS_KEY: undefined });
    expect(() => loadConfig()).toThrow(/never the shared AWS key/);
  });

  it('refuses an SES key that is the payment-secrets key under another name', () => {
    process.env = env({ SES_AWS_ACCESS_KEY_ID: 'AKIASECRETSEXAMPLE' });
    expect(() => loadConfig()).toThrow(/same key as AWS_ACCESS_KEY_ID/);
  });

  it('is not skipped by ALLOW_UNDELIVERABLE_NOTIFICATIONS', () => {
    // That switch is for booting with mail OFF. A production that chose SES is not doing that.
    process.env = env({ ALLOW_UNDELIVERABLE_NOTIFICATIONS: 'true', SES_CONFIGURATION_SET: '' });
    expect(() => loadConfig()).toThrow(/SES_CONFIGURATION_SET is not set/);
  });

  it('leaves production on log booting exactly as it does today', () => {
    // Production holds QA's names today with EMAIL_PROVIDER=log. That keeps booting until the
    // owner moves it, so this guard forces no change before the AWS work is done.
    process.env = env({
      EMAIL_PROVIDER: 'log',
      ALLOW_UNDELIVERABLE_NOTIFICATIONS: 'true',
      SES_CONFIGURATION_SET: 'eticketsgo-qa',
      SES_SNS_TOPIC_ARNS: 'arn:aws:sns:ap-south-1:123456789012:eticketsgo-ses-events-qa',
      SES_AWS_ACCESS_KEY_ID: undefined,
      SES_AWS_SECRET_ACCESS_KEY: undefined,
    });
    expect(() => loadConfig()).not.toThrow();
  });

  describe('QA/PROD isolation', () => {
    it.each(['eticketsgo-qa', 'eticketsgo-uat', 'qa', 'eticketsgo_test'])(
      'refuses production sending under the configuration set %s',
      (set) => {
        process.env = env({ SES_CONFIGURATION_SET: set });
        expect(() => loadConfig()).toThrow(/names another environment/);
      },
    );

    it("refuses another environment's SNS topic, alone or next to production's", () => {
      const qaTopic = 'arn:aws:sns:ap-south-1:123456789012:eticketsgo-ses-events-qa';
      process.env = env({ SES_SNS_TOPIC_ARNS: qaTopic });
      expect(() => loadConfig()).toThrow(/another environment's topic/);
      process.env = env({ SES_SNS_TOPIC_ARNS: `${READY.SES_SNS_TOPIC_ARNS},${qaTopic}` });
      expect(() => loadConfig()).toThrow(/another environment's topic/);
    });

    it('does not mistake a word that merely contains "qa" or "test" for an environment', () => {
      process.env = env({ SES_CONFIGURATION_SET: 'eticketsgo-prod-latest' });
      expect(() => loadConfig()).not.toThrow();
    });

    it('lets STAGING use its own staging names', () => {
      process.env = env({
        APP_ENV: 'STAGING',
        SES_CONFIGURATION_SET: 'eticketsgo-staging',
        SES_SNS_TOPIC_ARNS: 'arn:aws:sns:ap-south-1:123456789012:eticketsgo-ses-events-staging',
      });
      expect(() => loadConfig()).not.toThrow();
    });

    it('boots QA unchanged: QA names, the shared key, no dedicated pair', () => {
      process.env = env({
        APP_ENV: 'QA',
        SES_CONFIGURATION_SET: 'eticketsgo-qa',
        SES_SNS_TOPIC_ARNS: 'arn:aws:sns:ap-south-1:123456789012:eticketsgo-ses-events-qa',
        SES_AWS_ACCESS_KEY_ID: undefined,
        SES_AWS_SECRET_ACCESS_KEY: undefined,
      });
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it('refuses a malformed topic ARN or a sender with a display name', () => {
    process.env = env({ SES_SNS_TOPIC_ARNS: 'eticketsgo-ses-events-prod' });
    expect(() => loadConfig()).toThrow(/not an SNS topic ARN/);
    process.env = env({ EMAIL_FROM: 'ETicketsGo <tickets@eticketsgo.com>' });
    expect(() => loadConfig()).toThrow(/bare address/);
  });

  it('refuses half an SES key pair in QA too', () => {
    process.env = env({
      APP_ENV: 'QA',
      EMAIL_PROVIDER: 'log',
      SES_AWS_SECRET_ACCESS_KEY: undefined,
    });
    expect(() => loadConfig()).toThrow(/set together/);
  });
});
