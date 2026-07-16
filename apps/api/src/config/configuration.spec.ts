import { loadConfig } from './configuration';

/**
 * The production-hardening guard must fail closed on shipped placeholder / weak core
 * signing secrets and unconfigured CORS, while leaving lower environments untouched.
 */
describe('loadConfig production hardening', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);

  const prodBase = (): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
    CORS_ORIGINS: 'https://app.eticketsgo.com',
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('accepts a fully-configured production env', () => {
    process.env = prodBase();
    expect(() => loadConfig()).not.toThrow();
  });

  it.each([
    ['JWT_ACCESS_SECRET', 'CHANGE_ME_secret'],
    ['QR_SIGNING_SECRET', 'replace_me'],
    ['PAYMENT_WEBHOOK_SECRET', 'your_webhook_placeholder'],
  ])('rejects a placeholder %s in production', (key, value) => {
    process.env = { ...prodBase(), [key]: value };
    expect(() => loadConfig()).toThrow(/Insecure production configuration/);
  });

  it('rejects a too-short core secret in production', () => {
    process.env = { ...prodBase(), JWT_ACCESS_SECRET: 'short' };
    expect(() => loadConfig()).toThrow(/too short/);
  });

  it('rejects unset / localhost CORS in production', () => {
    const env = prodBase();
    delete env.CORS_ORIGINS;
    process.env = env;
    expect(() => loadConfig()).toThrow(/CORS_ORIGINS/);
  });

  it('does NOT enforce hardening in development (placeholders allowed locally)', () => {
    process.env = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@db/x',
      JWT_ACCESS_SECRET: 'dev-change-me',
      JWT_REFRESH_SECRET: 'dev-change-me',
      QR_SIGNING_SECRET: 'dev-change-me',
      PAYMENT_WEBHOOK_SECRET: 'dev-change-me',
    };
    expect(() => loadConfig()).not.toThrow();
  });
});
