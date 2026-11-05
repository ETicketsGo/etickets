import { HttpStatus } from '@nestjs/common';
import { loadConfig } from '../config/configuration';
import { PhoneOtpService } from './phone-otp.service';
import { SmsChannel } from '../notifications/channels/sms.channel';
import { NotificationProviderResolver } from '../notifications/channels/notification-provider.resolver';
import { withTransactions } from './test-support/otp-sms-memory-store';

/**
 * The India pilot posture: email carries every message, text messages are not yet possible.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 * docs/pilot/INDIA-COMMUNICATIONS.md recommends running the pilot with DLT unapproved and no
 * MSG91 credentials. That posture was only proved in pieces: the boot guard against a LOG
 * transport, and the OTP refusal against a MOCKED `SmsChannel`. Nothing drove the real
 * chain -- config, resolver, MSG91 transport, OTP service -- with India declared as MSG91 and
 * no credentials, which is the one way to keep the email boot guard ON while SMS is
 * deliberately unavailable (the alternative, ALLOW_UNDELIVERABLE_NOTIFICATIONS, switches the
 * email guard off too).
 *
 * The chain below is real; only the database and the network are absent. `fetch` is spied so
 * "no credentials" cannot quietly mean "called MSG91 with an empty key".
 */
describe('India pilot posture: email only, no SMS credentials', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);

  const pilotEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
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
    EMAIL_PROVIDER: 'ses',
    EMAIL_FROM: 'tickets@eticketsgo.com',
    // The rest of production SES (configuration.ses-production.spec.ts owns these).
    AWS_REGION: 'ap-south-1',
    SES_CONFIGURATION_SET: 'eticketsgo-prod',
    SES_AWS_ACCESS_KEY_ID: 'AKIASESONLYEXAMPLE',
    SES_AWS_SECRET_ACCESS_KEY: 'ses-only-secret',
    SES_SNS_TOPIC_ARNS: 'arn:aws:sns:ap-south-1:123456789012:eticketsgo-ses-events-prod',
    SES_WEBHOOK_SECRET: 'w'.repeat(40),
    NOTIFICATION_MARKETS: 'IN',
    SMS_PROVIDER_BY_MARKET: 'IN=msg91',
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('boots without the undeliverable escape hatch', () => {
    process.env = pilotEnv();
    expect(() => loadConfig()).not.toThrow();
  });

  it('still refuses to boot if email is not real -- the guard the escape hatch would remove', () => {
    process.env = pilotEnv({ EMAIL_PROVIDER: 'log', EMAIL_FROM: undefined });
    expect(() => loadConfig()).toThrow(/SENDS NOTHING/);
  });

  describe('phone sign-in through the real SMS chain', () => {
    function build() {
      const env: Record<string, string | undefined> = {
        APP_ENV: 'PRODUCTION',
        NODE_ENV: 'production',
        NOTIFICATION_MARKETS: 'IN',
        SMS_PROVIDER_BY_MARKET: 'IN=msg91',
        // Deliberately no MSG91_AUTH_KEY, no template ids, no sender id.
      };
      const config = { get: (k: string) => env[k] };
      const resolver = new NotificationProviderResolver(config as never);
      const sms = new SmsChannel(resolver);
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma = withTransactions({
        phoneOtp: {
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue({}),
          updateMany,
        },
      });
      const service = new PhoneOtpService(prisma as never, sms, config as never);
      return { service, updateMany };
    }

    it('answers 503 SMS_UNAVAILABLE that points at email, never "code sent"', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const { service } = build();
      await expect(service.requestCode('+919704464007')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: expect.stringContaining('email address'),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('leaves no redeemable code behind', async () => {
      const { service, updateMany } = build();
      await service.requestCode('+919704464007').catch(() => undefined);
      // The last write is the one that consumes the undelivered code.
      const lastCall = updateMany.mock.calls[updateMany.mock.calls.length - 1][0];
      expect(lastCall.where).toMatchObject({ phone: '+919704464007', consumedAt: null });
      expect(lastCall.data.consumedAt).toBeInstanceOf(Date);
    });
  });
});
