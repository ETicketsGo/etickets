import { ConfigService } from '@nestjs/config';
import { FailureClass, NotificationType } from '@eticketsgo/shared-types';
import { TemplateBindingService } from '../../templates/template-binding.service';
import { RenderedNotification } from '../notification-channel.interface';
import { TransportError } from './transport-http';
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

/** A binding source holding exactly the entries a test cares about. */
function bindingsFor(raw: string): TemplateBindingService {
  return new TemplateBindingService(configFor({ NOTIFICATION_TEMPLATE_BINDINGS: raw }));
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
  it('POSTs an APPROVED TEMPLATE to the Graph API, never free text', async () => {
    /*
      WhatsApp permits free-form text only inside a 24-hour window the RECIPIENT opens by
      writing to the business first. Every message this platform sends is business-initiated,
      so no such window exists and Meta refuses a `type: 'text'` send. This transport sent
      exactly that for three phases: it would have failed on the first real message, and the
      400 would have read as a bad credential rather than a bad message shape.
    */
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await new CloudWhatsAppTransport(
      cloudConfig,
      bindingsFor('cloud:whatsapp:EVENT_REMINDER:*=reminder_v1'),
    ).send(msg());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v20.0/99887766/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer EAAtoken');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '+15551230000',
      type: 'template',
      template: {
        name: 'reminder_v1',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Your event is coming up.' }] },
        ],
      },
    });
  });

  it('refuses permanently, without calling Meta, when no template is bound', async () => {
    const err = await new CloudWhatsAppTransport(cloudConfig, bindingsFor(''))
      .send(msg())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect((err as TransportError).retryable).toBe(false);
    // Nothing is sent under a guessed template name: Meta accepts it and the message is
    // dropped, which surfaces days later as a customer who never got their ticket.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the template approved for the reader language, not a default one', async () => {
    /*
      Template approvals are PER LANGUAGE and carry different names. Falling back to an
      English approval for a French reader is not a degraded success -- it is the wrong
      language, delivered confidently, with no error anywhere.
    */
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const bindings = bindingsFor(
      'cloud:whatsapp:EVENT_REMINDER:en=reminder_en,cloud:whatsapp:EVENT_REMINDER:fr-CA=reminder_fr',
    );
    await new CloudWhatsAppTransport(cloudConfig, bindings).send(msg({ locale: 'fr-CA' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.template.name).toBe('reminder_fr');
    expect(body.template.language.code).toBe('fr-CA');
  });

  it('skips cleanly (no fetch, no throw) when payload has no phone', async () => {
    // A skip is now REPORTED rather than silent: nothing was delivered, and the row that
    // records this will say so instead of claiming a successful send.
    await expect(
      new CloudWhatsAppTransport(cloudConfig).send(msg({ payload: {} })),
    ).resolves.toMatchObject({ skipped: true, reason: 'no_destination' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response so retry/FAILED handling runs', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad token' });
    const bindings = bindingsFor('cloud:whatsapp:EVENT_REMINDER:*=reminder_v1');
    const err = await new CloudWhatsAppTransport(cloudConfig, bindings)
      .send(msg())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).message).toMatch(/HTTP 401/);
    // A 401 is our credential, not their outage, and must not count against Meta's health.
    expect((err as TransportError).failureClass).toBe(FailureClass.AUTHENTICATION_ERROR);
    expect((err as TransportError).retryable).toBe(false);
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
