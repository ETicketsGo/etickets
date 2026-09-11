import { loadConfig } from './configuration';

/**
 * Text-message configuration that must not boot.
 *
 * Each of these used to start clean and fail later, somewhere nobody was looking: a production
 * in SMS log mode locked every phone user out while reporting healthy; a routing typo sent a
 * whole market's messages to the log transport; a PUBLIC_API_URL with a path made every Twilio
 * callback fail its signature; a mistyped Messaging Service SID became a provider 404 on every
 * send. Refused at boot, they are one clear line in a deploy log instead.
 */
describe('loadConfig: SMS', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);
  const MS_SID = `MG${'0123456789abcdef'.repeat(2)}`;

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
    SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio,CA=twilio',
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  describe('log mode where customers are served', () => {
    it('refuses production with SMS in log mode', () => {
      process.env = env({ SMS_PROVIDER_BY_MARKET: undefined, SMS_PROVIDER: 'log' });
      expect(() => loadConfig()).toThrow(/SMS_PROVIDER=log SENDS NO TEXT MESSAGES/);
    });

    it('refuses production with an enabled market routed to log, and names it', () => {
      process.env = env({ SMS_PROVIDER_BY_MARKET: 'IN=log,US=twilio,CA=twilio' });
      expect(() => loadConfig()).toThrow(/routes IN to log/);
    });

    it('refuses staging the same way', () => {
      process.env = env({ APP_ENV: 'STAGING', SMS_PROVIDER_BY_MARKET: undefined });
      expect(() => loadConfig()).toThrow(/SENDS NO TEXT MESSAGES/);
    });

    it('boots production with every enabled market on a real provider', () => {
      process.env = env();
      expect(() => loadConfig()).not.toThrow();
    });

    it('honours the existing escape hatch for migrations and smoke checks', () => {
      process.env = env({
        SMS_PROVIDER_BY_MARKET: undefined,
        ALLOW_UNDELIVERABLE_NOTIFICATIONS: 'true',
      });
      expect(() => loadConfig()).not.toThrow();
    });

    it.each(['LOCAL', 'DEV', 'QA', 'UAT'])(
      'leaves %s alone, even on a production build',
      (appEnv) => {
        process.env = env({ APP_ENV: appEnv, SMS_PROVIDER_BY_MARKET: undefined });
        expect(() => loadConfig()).not.toThrow();
      },
    );

    it('boots the QA certification route: India in log mode, North America on Twilio', () => {
      process.env = env({
        APP_ENV: 'QA',
        SMS_PROVIDER_BY_MARKET: 'IN=log,US=twilio,CA=twilio',
        NOTIFICATION_MARKETS: 'IN,US,CA',
      });
      expect(() => loadConfig()).not.toThrow();
    });
  });

  describe('routing tables', () => {
    it('refuses a provider name the transports do not know, instead of logging it away', () => {
      process.env = env({ APP_ENV: 'QA', SMS_PROVIDER_BY_MARKET: 'IN=log,US=twillio,CA=twilio' });
      expect(() => loadConfig()).toThrow(/routes US to "twillio", which is not a SMS provider/);
    });

    it('refuses the same for WhatsApp', () => {
      process.env = env({ APP_ENV: 'QA', WHATSAPP_PROVIDER_BY_MARKET: 'US=whatsapp' });
      expect(() => loadConfig()).toThrow(/not a WhatsApp provider/);
    });
  });

  describe('PUBLIC_API_URL', () => {
    it.each(['https://api-qa.eticketsgo.com', 'https://api-qa.eticketsgo.com/'])(
      'accepts the origin %s',
      (value) => {
        process.env = env({ APP_ENV: 'QA', PUBLIC_API_URL: value });
        expect(() => loadConfig()).not.toThrow();
      },
    );

    it.each([
      ['a path', 'https://api-qa.eticketsgo.com/api'],
      ['a query', 'https://api-qa.eticketsgo.com/?x=1'],
      ['no scheme', 'api-qa.eticketsgo.com'],
    ])('refuses %s, which would fail every Twilio signature', (_name, value) => {
      process.env = env({ APP_ENV: 'QA', PUBLIC_API_URL: value });
      expect(() => loadConfig()).toThrow(/PUBLIC_API_URL/);
    });
  });

  describe('TWILIO_MESSAGING_SERVICE_SID', () => {
    it('accepts a well-formed SID', () => {
      process.env = env({ TWILIO_MESSAGING_SERVICE_SID: MS_SID });
      expect(() => loadConfig()).not.toThrow();
    });

    it.each([
      ['a phone number', '+18445550100'],
      ['an account SID', `AC${'0123456789abcdef'.repeat(2)}`],
      ['a truncated SID', 'MG0123'],
    ])('refuses %s', (_name, value) => {
      process.env = env({ TWILIO_MESSAGING_SERVICE_SID: value });
      expect(() => loadConfig()).toThrow(/TWILIO_MESSAGING_SERVICE_SID/);
    });

    it('treats an empty value as unset rather than as a malformed SID', () => {
      process.env = env({ TWILIO_MESSAGING_SERVICE_SID: '' });
      expect(() => loadConfig()).not.toThrow();
    });
  });
});
