import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FailureClass, NotificationType, SuppressionReason } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';
import { SmsLogTransport, TwilioSmsTransport, selectSmsTransport } from './sms.transport';
import { TransportError } from './transport-http';

const mockMessagesCreate = jest.fn().mockResolvedValue({ sid: 'SM1' });
jest.mock('twilio', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } })),
}));

/** A plain lookup, so nothing in the ambient process environment can leak into a case. */
function configFor(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

const PHONE = '+15551230000';
const CODE_BODY = 'Your ETicketsGo sign-in code is 424242. It expires in 10 minutes.';

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.EVENT_REMINDER,
    channel: 'sms',
    locale: 'en',
    toEmail: null,
    userId: 'u1',
    subject: 'Reminder',
    body: CODE_BODY,
    payload: { phone: PHONE },
    ...over,
  };
}

const MESSAGING_SERVICE_SID = `MG${'a'.repeat(32)}`;
const twilioConfig = configFor({
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_MESSAGING_SERVICE_SID: MESSAGING_SERVICE_SID,
});

let logged: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => logged.mockRestore());

const logText = () => logged.mock.calls.flat().map(String).join('\n');

describe('SmsLogTransport', () => {
  it('prints the body on a developer machine, which is what it is for', async () => {
    await new SmsLogTransport(configFor({ APP_ENV: 'LOCAL', NODE_ENV: 'development' })).send(msg());
    expect(logText()).toContain('424242');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it.each(['QA', 'UAT', 'STAGING', 'PRODUCTION'])(
    'never prints the body, the code or the number in %s',
    async (appEnv) => {
      await new SmsLogTransport(configFor({ APP_ENV: appEnv, NODE_ENV: 'production' })).send(msg());
      const text = logText();
      expect(text).not.toContain('424242');
      expect(text).not.toContain(CODE_BODY);
      expect(text).not.toContain('5551230000');
      // It still says something happened -- silence would look like a missing message.
      expect(text).toMatch(/content withheld/);
    },
  );

  it('withholds on a LOCAL label running a production build', async () => {
    // A deployed environment that forgot APP_ENV defaults to LOCAL; NODE_ENV still says where.
    await new SmsLogTransport(configFor({ APP_ENV: 'LOCAL', NODE_ENV: 'production' })).send(msg());
    expect(logText()).not.toContain('424242');
  });

  it('withholds when it has no configuration to decide with', async () => {
    await new SmsLogTransport().send(msg());
    expect(logText()).not.toContain('424242');
  });
});

describe('TwilioSmsTransport', () => {
  it('sends through the Messaging Service, and never with a from-number', async () => {
    await new TwilioSmsTransport(twilioConfig).send(msg());
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const args = mockMessagesCreate.mock.calls[0][0];
    expect(args).toEqual({
      to: PHONE,
      messagingServiceSid: MESSAGING_SERVICE_SID,
      body: CODE_BODY,
    });
    // Both at once would let Twilio's precedence rules decide which sender carried it.
    expect(args).not.toHaveProperty('from');
  });

  it('ignores a leftover TWILIO_FROM_NUMBER entirely', async () => {
    await new TwilioSmsTransport(
      configFor({
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_MESSAGING_SERVICE_SID: MESSAGING_SERVICE_SID,
        TWILIO_FROM_NUMBER: '+15005550006',
      }),
    ).send(msg());
    expect(mockMessagesCreate.mock.calls[0][0]).not.toHaveProperty('from');
  });

  it('refuses to construct without a Messaging Service, even with a from-number', () => {
    let thrown: unknown;
    try {
      new TwilioSmsTransport(
        configFor({
          TWILIO_ACCOUNT_SID: 'AC1',
          TWILIO_AUTH_TOKEN: 'tok',
          TWILIO_FROM_NUMBER: '+15005550006',
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TransportError);
    expect((thrown as TransportError).failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
    expect((thrown as TransportError).message).toMatch(/TWILIO_MESSAGING_SERVICE_SID/);
  });

  it('skips cleanly (no send, no throw) when there is no number', async () => {
    await expect(
      new TwilioSmsTransport(twilioConfig).send(msg({ payload: { bookingId: 'bk-1' } })),
    ).resolves.toMatchObject({ skipped: true, reason: 'no_destination' });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('declares that Twilio itself enforces opt-out', () => {
    expect(new TwilioSmsTransport(twilioConfig).enforcesOptOut).toBe(true);
  });

  it("strips the number from Twilio's error and keeps the code apart", async () => {
    mockMessagesCreate.mockRejectedValueOnce({
      code: 21211,
      status: 400,
      message: `The 'To' number ${PHONE} is not a valid phone number.`,
    });
    const err = (await new TwilioSmsTransport(twilioConfig)
      .send(msg())
      .catch((e) => e)) as TransportError;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.failureClass).toBe(FailureClass.INVALID_DESTINATION);
    expect(err.providerCode).toBe('21211');
    expect(err.message).not.toContain('5551230000');
    expect(err.message).toContain('21211');
  });

  it('marks a STOP refusal as an unsubscribe the channel must remember', async () => {
    mockMessagesCreate.mockRejectedValueOnce({
      code: 21610,
      status: 400,
      message: 'Attempt to send to unsubscribed recipient',
    });
    const err = (await new TwilioSmsTransport(twilioConfig)
      .send(msg())
      .catch((e) => e)) as TransportError;
    expect(err.suppression).toBe(SuppressionReason.UNSUBSCRIBED);
    expect(err.failureClass).toBe(FailureClass.COMPLIANCE_BLOCKED);
  });

  it('propagates an unclassified provider error so retry/FAILED handling runs', async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error('twilio 500'));
    await expect(new TwilioSmsTransport(twilioConfig).send(msg())).rejects.toThrow('twilio 500');
  });

  it('fails fast when TWILIO_ACCOUNT_SID is missing', () => {
    expect(() => new TwilioSmsTransport(configFor({ TWILIO_AUTH_TOKEN: 't' }))).toThrow(
      /TWILIO_ACCOUNT_SID/,
    );
  });
});

describe('selectSmsTransport', () => {
  it('defaults to the log transport when SMS_PROVIDER is unset', () => {
    expect(selectSmsTransport(configFor({}))).toBeInstanceOf(SmsLogTransport);
  });

  it('selects Twilio when SMS_PROVIDER=twilio', () => {
    const t = selectSmsTransport(
      configFor({
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_MESSAGING_SERVICE_SID: MESSAGING_SERVICE_SID,
      }),
    );
    expect(t).toBeInstanceOf(TwilioSmsTransport);
  });

  it('fails fast when Twilio is selected without keys', () => {
    expect(() => selectSmsTransport(configFor({ SMS_PROVIDER: 'twilio' }))).toThrow(
      /TWILIO_ACCOUNT_SID/,
    );
  });
});
