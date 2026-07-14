import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';
import { SmsLogTransport, TwilioSmsTransport, selectSmsTransport } from './sms.transport';

const mockMessagesCreate = jest.fn().mockResolvedValue({ sid: 'SM1' });
jest.mock('twilio', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } })),
}));

function configFor(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.EVENT_REMINDER,
    channel: 'sms',
    locale: 'en',
    toEmail: null,
    userId: 'u1',
    subject: 'Reminder',
    body: 'Your event is coming up.',
    payload: { phone: '+15551230000' },
    ...over,
  };
}

const twilioConfig = configFor({
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_FROM_NUMBER: '+15005550006',
});

beforeEach(() => jest.clearAllMocks());

describe('SmsLogTransport (default)', () => {
  it('logs and does not call any real provider', async () => {
    await new SmsLogTransport().send(msg());
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe('TwilioSmsTransport', () => {
  it('sends to payload.phone with the configured from-number and rendered body', async () => {
    await new TwilioSmsTransport(twilioConfig).send(msg());
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: '+15551230000',
      from: '+15005550006',
      body: 'Your event is coming up.',
    });
  });

  it('skips cleanly (no send, no throw) when payload has no phone', async () => {
    await expect(
      new TwilioSmsTransport(twilioConfig).send(msg({ payload: { bookingId: 'bk-1' } })),
    ).resolves.toBeUndefined();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('propagates a provider error so retry/FAILED handling runs', async () => {
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
        TWILIO_FROM_NUMBER: '+1',
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
