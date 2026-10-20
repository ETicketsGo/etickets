import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';
import {
  EmailLogTransport,
  SendGridEmailTransport,
  SesEmailTransport,
  resolveSesCredentials,
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

  it('passes a Reply-To through when the channel gave one', async () => {
    await new SendGridEmailTransport(config).send(msg({ replyTo: 'asha@gmail.com' }));
    expect(mockSgSend).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'asha@gmail.com' }));
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

  it('sets ReplyToAddresses only when the channel gave a Reply-To', async () => {
    // A support-form copy: "Reply" in Outlook must answer the person who wrote.
    await new SesEmailTransport(config).send(msg({ replyTo: 'asha@gmail.com' }));
    const withReply = mockSesSend.mock.calls[0][0] as { __command: Record<string, unknown> };
    expect(withReply.__command.ReplyToAddresses).toEqual(['asha@gmail.com']);

    // Every other message keeps replies on the From address, exactly as before.
    await new SesEmailTransport(config).send(msg());
    const plain = mockSesSend.mock.calls[1][0] as { __command: Record<string, unknown> };
    expect(plain.__command).not.toHaveProperty('ReplyToAddresses');
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

describe('SesEmailTransport: a hung connection', () => {
  it('bounds both the connection and the request, so one stalled socket cannot block the worker', () => {
    /*
      The SDK's default handler waits forever. Every notification runs through one worker at a
      concurrency of one, so without these a single unanswered SES socket stops every later
      email, SMS and hold expiry behind it.
    */
    const { SESv2Client } = jest.requireMock('@aws-sdk/client-sesv2') as { SESv2Client: jest.Mock };
    new SesEmailTransport(configFor({ AWS_REGION: 'ap-south-1', EMAIL_FROM: 'x@y.test' }));
    expect(SESv2Client.mock.calls.at(-1)?.[0]).toMatchObject({
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
    });
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

/*
  R4: the SES key is its own IAM user. The shared AWS_ACCESS_KEY_ID pair is what the default
  credential chain reads, and so what the payment secret store signs with; production email
  must never be sent with it.
*/
describe('SesEmailTransport: which AWS key signs the send', () => {
  const sesClientArgs = () => {
    const { SESv2Client } = jest.requireMock('@aws-sdk/client-sesv2') as { SESv2Client: jest.Mock };
    return SESv2Client.mock.calls.at(-1)?.[0] as { credentials?: Record<string, string> };
  };
  const SHARED = { AWS_ACCESS_KEY_ID: 'AKIASHARED', AWS_SECRET_ACCESS_KEY: 'shared-secret' };
  const DEDICATED = {
    SES_AWS_ACCESS_KEY_ID: 'AKIASESONLY',
    SES_AWS_SECRET_ACCESS_KEY: 'ses-secret',
  };
  const base = { AWS_REGION: 'ap-south-1', EMAIL_FROM: 'tickets@eticketsgo.com' };

  it('uses the dedicated SES pair when it is set, even with the shared pair present', () => {
    new SesEmailTransport(configFor({ ...base, ...SHARED, ...DEDICATED, APP_ENV: 'PRODUCTION' }));
    expect(sesClientArgs().credentials).toEqual({
      accessKeyId: 'AKIASESONLY',
      secretAccessKey: 'ses-secret',
    });
  });

  it('passes only the key to the SDK, not the source label', () => {
    new SesEmailTransport(configFor({ ...base, ...DEDICATED }));
    expect(Object.keys(sesClientArgs().credentials ?? {}).sort()).toEqual([
      'accessKeyId',
      'secretAccessKey',
    ]);
  });

  it.each(['PRODUCTION', 'STAGING'])('refuses to sign with the shared key in %s', (APP_ENV) => {
    expect(() => new SesEmailTransport(configFor({ ...base, ...SHARED, APP_ENV }))).toThrow(
      /SES_AWS_ACCESS_KEY_ID/,
    );
    // Nor does it drop to the default chain, which would find the same shared key.
    expect(() => new SesEmailTransport(configFor({ ...base, APP_ENV }))).toThrow(
      /SES_AWS_ACCESS_KEY_ID/,
    );
  });

  it('refuses half a dedicated pair in any environment', () => {
    for (const APP_ENV of ['QA', 'PRODUCTION']) {
      expect(() =>
        resolveSesCredentials(configFor({ APP_ENV, SES_AWS_ACCESS_KEY_ID: 'AKIASESONLY' })),
      ).toThrow(/set together/);
      expect(() =>
        resolveSesCredentials(configFor({ APP_ENV, SES_AWS_SECRET_ACCESS_KEY: 'x' })),
      ).toThrow(/set together/);
    }
  });

  it('keeps QA exactly as configured today: the shared pair, unchanged', () => {
    new SesEmailTransport(configFor({ ...base, ...SHARED, APP_ENV: 'QA' }));
    expect(sesClientArgs().credentials).toEqual({
      accessKeyId: 'AKIASHARED',
      secretAccessKey: 'shared-secret',
    });
    expect(resolveSesCredentials(configFor({ ...SHARED, APP_ENV: 'QA' }))?.source).toBe('shared');
  });

  it('lets QA move to a dedicated pair without touching the shared one', () => {
    expect(
      resolveSesCredentials(configFor({ ...SHARED, ...DEDICATED, APP_ENV: 'QA' }))?.source,
    ).toBe('dedicated');
  });

  it('falls back to the default chain only outside STAGING/PRODUCTION', () => {
    new SesEmailTransport(configFor({ ...base, APP_ENV: 'LOCAL' }));
    expect(sesClientArgs()).not.toHaveProperty('credentials');
  });
});

describe('SesEmailTransport: the configuration set on every send', () => {
  it('names SES_CONFIGURATION_SET on every message, Reply-To or not', async () => {
    const t = new SesEmailTransport(
      configFor({
        AWS_REGION: 'ap-south-1',
        EMAIL_FROM: 'tickets@eticketsgo.com',
        SES_CONFIGURATION_SET: 'eticketsgo-prod',
        SES_AWS_ACCESS_KEY_ID: 'AKIASESONLY',
        SES_AWS_SECRET_ACCESS_KEY: 'ses-secret',
        APP_ENV: 'PRODUCTION',
      }),
    );
    await t.send(msg());
    await t.send(msg({ type: NotificationType.BOOKING_CANCELLED }));
    await t.send(msg({ replyTo: 'asha@gmail.com' }));
    for (const [command] of mockSesSend.mock.calls as [{ __command: Record<string, unknown> }][]) {
      expect(command.__command).toMatchObject({
        FromEmailAddress: 'tickets@eticketsgo.com',
        ConfigurationSetName: 'eticketsgo-prod',
      });
    }
    expect(mockSesSend).toHaveBeenCalledTimes(3);
  });
});
