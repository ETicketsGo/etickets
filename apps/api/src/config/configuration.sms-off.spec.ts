import { loadConfig } from './configuration';

/**
 * SMS declared off on purpose (SMS_ENABLED=false).
 *
 * A pilot with no SMS provider used to need ALLOW_UNDELIVERABLE_NOTIFICATIONS, which also
 * switched off the guard that refuses EMAIL_PROVIDER=log. SMS_ENABLED=false relaxes the SMS
 * half only.
 */
describe('loadConfig: SMS_ENABLED=false', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);
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
    EMAIL_PROVIDER: 'ses',
    EMAIL_FROM: 'tickets@eticketsgo.com',
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('still refuses production with SMS in log mode when SMS is not declared off', () => {
    process.env = env({ SMS_PROVIDER: 'log' });
    expect(() => loadConfig()).toThrow(/SENDS NO TEXT MESSAGES/);
  });

  it('boots production with no SMS provider and no bypass when SMS is declared off', () => {
    process.env = env({ SMS_ENABLED: 'false', SMS_PROVIDER: 'log' });
    expect(() => loadConfig()).not.toThrow();
  });

  it('boots with an enabled market routed to log when SMS is declared off', () => {
    process.env = env({ SMS_ENABLED: 'false', SMS_PROVIDER_BY_MARKET: 'IN=log' });
    expect(() => loadConfig()).not.toThrow();
  });

  it('keeps refusing EMAIL_PROVIDER=log when SMS is declared off', () => {
    process.env = env({ SMS_ENABLED: 'false', EMAIL_PROVIDER: 'log' });
    expect(() => loadConfig()).toThrow(/EMAIL_PROVIDER=log/);
  });

  it('does not accept a value that is not true or false', () => {
    process.env = env({ SMS_ENABLED: 'off' });
    expect(() => loadConfig()).toThrow();
  });
});
