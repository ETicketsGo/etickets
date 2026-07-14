import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';
import {
  CloudWhatsAppTransport,
  WhatsAppLogTransport,
  selectWhatsAppTransport,
} from './whatsapp.transport';

function configFor(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.EVENT_REMINDER,
    channel: 'whatsapp',
    locale: 'en',
    toEmail: null,
    userId: 'u1',
    subject: 'Reminder',
    body: 'Your event is coming up.',
    payload: { phone: '+15551230000' },
    ...over,
  };
}

const cloudConfig = configFor({
  WHATSAPP_PHONE_NUMBER_ID: '99887766',
  WHATSAPP_ACCESS_TOKEN: 'EAAtoken',
});

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('WhatsAppLogTransport (default)', () => {
  it('logs and never calls fetch', async () => {
    await new WhatsAppLogTransport().send(msg());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CloudWhatsAppTransport', () => {
  it('POSTs a text message to the Graph API with the token and payload.phone', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await new CloudWhatsAppTransport(cloudConfig).send(msg());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v20.0/99887766/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer EAAtoken');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '+15551230000',
      type: 'text',
      text: { body: 'Your event is coming up.' },
    });
  });

  it('skips cleanly (no fetch, no throw) when payload has no phone', async () => {
    await expect(
      new CloudWhatsAppTransport(cloudConfig).send(msg({ payload: {} })),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response so retry/FAILED handling runs', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad token' });
    await expect(new CloudWhatsAppTransport(cloudConfig).send(msg())).rejects.toThrow(/HTTP 401/);
  });

  it('fails fast when WHATSAPP_PHONE_NUMBER_ID is missing', () => {
    expect(() => new CloudWhatsAppTransport(configFor({ WHATSAPP_ACCESS_TOKEN: 't' }))).toThrow(
      /WHATSAPP_PHONE_NUMBER_ID/,
    );
  });
});

describe('selectWhatsAppTransport', () => {
  it('defaults to the log transport when WHATSAPP_PROVIDER is unset', () => {
    expect(selectWhatsAppTransport(configFor({}))).toBeInstanceOf(WhatsAppLogTransport);
  });

  it('selects the Cloud transport when WHATSAPP_PROVIDER=cloud', () => {
    const t = selectWhatsAppTransport(
      configFor({
        WHATSAPP_PROVIDER: 'cloud',
        WHATSAPP_PHONE_NUMBER_ID: '1',
        WHATSAPP_ACCESS_TOKEN: 't',
      }),
    );
    expect(t).toBeInstanceOf(CloudWhatsAppTransport);
  });

  it('fails fast when cloud is selected without keys', () => {
    expect(() => selectWhatsAppTransport(configFor({ WHATSAPP_PROVIDER: 'cloud' }))).toThrow(
      /WHATSAPP_PHONE_NUMBER_ID/,
    );
  });
});
