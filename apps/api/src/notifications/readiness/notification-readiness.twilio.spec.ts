import { NotificationReadinessService } from './notification-readiness.service';

/**
 * What readiness says about Twilio and about SMS log mode.
 *
 * Readiness is what an operator reads before a launch, so it has to name the thing that
 * actually decides whether callbacks arrive -- the Messaging Service -- and hand over the exact
 * callback URL, because getting that URL byte-for-byte right is the whole difficulty.
 */

const MS_SID = `MG${'c'.repeat(32)}`;

function build(values: Record<string, string>) {
  const config = { get: (key: string) => values[key] };
  const prisma = {
    notificationRate: {
      findFirst: jest.fn().mockResolvedValue({ id: 'rate' }),
      count: jest.fn().mockResolvedValue(1),
    },
    webhookEvent: { count: jest.fn().mockResolvedValue(2) },
  };
  const bindings = {
    resolve: jest.fn().mockReturnValue(null),
    legacyCount: jest.fn().mockReturnValue(0),
  };
  return new NotificationReadinessService(config as never, prisma as never, bindings as never);
}

const TWILIO_US = {
  APP_ENV: 'QA',
  NODE_ENV: 'production',
  SMS_PROVIDER_BY_MARKET: 'IN=log,US=twilio,CA=twilio',
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'token',
  PUBLIC_API_URL: 'https://api-qa.eticketsgo.com',
};

const component = async (svc: NotificationReadinessService, market: string, key: string) =>
  (await svc.forMarket(market)).components.find((c) => c.key === key)!;

describe('readiness for Twilio SMS', () => {
  it('is not ready on account credentials alone: the Messaging Service is what sends', async () => {
    const sms = await component(
      build({ ...TWILIO_US, TWILIO_FROM_NUMBER: '+18445550100' }),
      'US',
      'sms',
    );
    expect(sms.state).toBe('PARTIAL');
    expect(sms.missingCredentials).toEqual(['TWILIO_MESSAGING_SERVICE_SID']);
  });

  it('is configured with the account and its Messaging Service', async () => {
    const sms = await component(
      build({ ...TWILIO_US, TWILIO_MESSAGING_SERVICE_SID: MS_SID }),
      'US',
      'sms',
    );
    expect(sms.state).toBe('CONFIGURED');
  });

  it('prints the exact Delivery Status Callback URL to paste into the Messaging Service', async () => {
    const callbacks = await component(
      build({ ...TWILIO_US, TWILIO_MESSAGING_SERVICE_SID: MS_SID }),
      'US',
      'delivery-callbacks',
    );
    expect(callbacks.detail).toContain(
      'https://api-qa.eticketsgo.com/api/notifications/webhooks/twilio',
    );
  });
});

describe('readiness for SMS log mode', () => {
  it('reports a QA market in log mode as deliberately disabled, with content withheld', async () => {
    const sms = await component(build(TWILIO_US), 'IN', 'sms');
    expect(sms.state).toBe('DISABLED');
    expect(sms.detail).toMatch(/log mode.*withheld/);
  });

  it('reports the same configuration in production as missing', async () => {
    const sms = await component(build({ ...TWILIO_US, APP_ENV: 'PRODUCTION' }), 'IN', 'sms');
    expect(sms.state).toBe('MISSING');
    expect(sms.detail).toMatch(/refuses to boot/);
  });

  it('says whether this process would log message content, and what is waiting to correlate', async () => {
    const qa = await build(TWILIO_US).report(['US']);
    expect(qa.platform.messageContentLogged).toBe(false);
    expect(qa.platform.callbacksAwaitingCorrelation).toBe(2);

    const laptop = await build({ ...TWILIO_US, APP_ENV: 'LOCAL', NODE_ENV: 'development' }).report([
      'US',
    ]);
    expect(laptop.platform.messageContentLogged).toBe(true);
  });
});
