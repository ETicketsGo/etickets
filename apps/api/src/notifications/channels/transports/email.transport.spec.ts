import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';
import {
  EmailLogTransport,
  SendGridEmailTransport,
  SesEmailTransport,
  selectEmailTransport,
} from './email.transport';

const mockSgSend = jest.fn().mockResolvedValue([{}]);
const mockSgSetApiKey = jest.fn();
jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  // Wrapped so the module factory does not touch the mock consts before they init.
  default: {
    setApiKey: (...a: unknown[]) => mockSgSetApiKey(...a),
    send: (...a: unknown[]) => mockSgSend(...a),
  },
}));

const mockSesSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn().mockImplementation((input: unknown) => ({ __command: input })),
}));

function configFor(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.BOOKING_CONFIRMED,
    channel: 'email',
    locale: 'en',
    toEmail: 'buyer@example.test',
    userId: 'u1',
    subject: 'Your booking is confirmed',
    body: 'Booking bk-1 is confirmed.',
    payload: { bookingId: 'bk-1' },
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('EmailLogTransport (default)', () => {
  it('logs and does not touch any real provider', async () => {
    await new EmailLogTransport().send(msg());
    expect(mockSgSend).not.toHaveBeenCalled();
    expect(mockSesSend).not.toHaveBeenCalled();
  });
});

describe('SendGridEmailTransport', () => {
  const config = configFor({ SENDGRID_API_KEY: 'SG.key', EMAIL_FROM: 'no-reply@etg.test' });

  it('sends with the expected recipient, sender, subject and body', async () => {
    await new SendGridEmailTransport(config).send(msg());
    expect(mockSgSetApiKey).toHaveBeenCalledWith('SG.key');
    expect(mockSgSend).toHaveBeenCalledWith({
      to: 'buyer@example.test',
      from: 'no-reply@etg.test',
      subject: 'Your booking is confirmed',
      text: 'Booking bk-1 is confirmed.',
    });
  });

  it('propagates a provider error so retry/FAILED handling runs', async () => {
    mockSgSend.mockRejectedValueOnce(new Error('sendgrid 401'));
    await expect(new SendGridEmailTransport(config).send(msg())).rejects.toThrow('sendgrid 401');
  });

  it('fails fast when SENDGRID_API_KEY is missing', () => {
    expect(() => new SendGridEmailTransport(configFor({ EMAIL_FROM: 'x@y.test' }))).toThrow(
      /SENDGRID_API_KEY/,
    );
  });
});

describe('SesEmailTransport', () => {
  const config = configFor({ AWS_REGION: 'us-east-1', EMAIL_FROM: 'no-reply@etg.test' });

  it('sends a SendEmailCommand with the expected recipient/fields', async () => {
    await new SesEmailTransport(config).send(msg());
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    const command = mockSesSend.mock.calls[0][0] as { __command: Record<string, unknown> };
    expect(command.__command).toMatchObject({
      FromEmailAddress: 'no-reply@etg.test',
      Destination: { ToAddresses: ['buyer@example.test'] },
      Content: {
        Simple: {
          Subject: { Data: 'Your booking is confirmed' },
          Body: { Text: { Data: 'Booking bk-1 is confirmed.' } },
        },
      },
    });
  });

  it('propagates a provider error so retry/FAILED handling runs', async () => {
    mockSesSend.mockRejectedValueOnce(new Error('ses throttled'));
    await expect(new SesEmailTransport(config).send(msg())).rejects.toThrow('ses throttled');
  });

  it('fails fast when AWS_REGION is missing', () => {
    expect(() => new SesEmailTransport(configFor({ EMAIL_FROM: 'x@y.test' }))).toThrow(
      /AWS_REGION/,
    );
  });
});

describe('selectEmailTransport', () => {
  it('defaults to the log transport when EMAIL_PROVIDER is unset', () => {
    expect(selectEmailTransport(configFor({}))).toBeInstanceOf(EmailLogTransport);
  });

  it('selects SendGrid when EMAIL_PROVIDER=sendgrid', () => {
    const t = selectEmailTransport(
      configFor({ EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'k', EMAIL_FROM: 'f@x.test' }),
    );
    expect(t).toBeInstanceOf(SendGridEmailTransport);
  });

  it('selects SES when EMAIL_PROVIDER=ses', () => {
    const t = selectEmailTransport(
      configFor({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'us-east-1', EMAIL_FROM: 'f@x.test' }),
    );
    expect(t).toBeInstanceOf(SesEmailTransport);
  });

  it('fails fast when a selected provider is missing keys', () => {
    expect(() => selectEmailTransport(configFor({ EMAIL_PROVIDER: 'sendgrid' }))).toThrow(
      /SENDGRID_API_KEY/,
    );
  });
});
