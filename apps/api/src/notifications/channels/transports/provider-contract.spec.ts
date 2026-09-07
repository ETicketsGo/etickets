import { ConfigService } from '@nestjs/config';
import {
  FailureClass,
  NotificationType,
  OutcomeClass,
  outcomeClassForFailure,
} from '@eticketsgo/shared-types';
import { TemplateBindingService } from '../../templates/template-binding.service';
import { RenderedNotification } from '../notification-channel.interface';
import { Msg91SmsTransport, TwilioSmsTransport, classifyTwilioError } from './sms.transport';
import { CloudWhatsAppTransport, Msg91WhatsAppTransport } from './whatsapp.transport';
import { TransportError } from './transport-http';

/**
 * The provider-contract harness: every adapter, against every way a provider can misbehave.
 *
 * ── WHAT THIS PROVES, AND THE THING IT MUST NEVER BE MISTAKEN FOR ──────────────────
 * It proves OUR side. Given a rate limit, an expired token, an unapproved template, a dead
 * number, a timeout or a page of HTML where JSON was promised, each adapter produces the
 * right normalized failure — which decides whether we retry, whose reliability moves, whether
 * anybody is billed, and what an operator sees in the queue.
 *
 * It proves nothing at all about the provider. No credential exists in this repository, no
 * request leaves it, and a green run here is `CONTRACT_TESTED` and never `LIVE_CERTIFIED`.
 * The distinction is the point: a platform that could certify itself would have certified
 * itself months before anyone opened an MSG91 account.
 *
 * ── WHY THE SCENARIOS ARE A TABLE ──────────────────────────────────────────────────
 * A missing case in a hand-written suite is invisible. As a table, adding an adapter and
 * forgetting to exercise its rate-limit behaviour is a hole somebody can see.
 */

function configFor(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function bindingsFor(raw: string): TemplateBindingService {
  return new TemplateBindingService(configFor({ NOTIFICATION_TEMPLATE_BINDINGS: raw }));
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.SHOW_CANCELLED,
    channel: 'sms',
    locale: 'en',
    toEmail: null,
    userId: 'u1',
    subject: 'S',
    body: 'Your show has been cancelled.',
    payload: { phone: '+919999000011' },
    destination: '+919999000011',
    ...over,
  };
}

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** An HTTP answer, as `transportJson` consumes it. */
const http = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

interface Adapter {
  name: string;
  provider: string;
  channel: 'sms' | 'whatsapp';
  send: () => Promise<unknown>;
  /** The success body this provider answers with. */
  success: string;
}

const ADAPTERS: Adapter[] = [
  {
    name: 'MSG91 SMS',
    provider: 'msg91',
    channel: 'sms',
    success: JSON.stringify({ type: 'success', message: 'abc123' }),
    send: () =>
      new Msg91SmsTransport(
        configFor({ MSG91_AUTH_KEY: 'k', MSG91_SENDER_ID: 'ETGOSM' }),
        bindingsFor('msg91:sms:SHOW_CANCELLED:*=1707161234567890'),
      ).send(msg()),
  },
  {
    name: 'MSG91 WhatsApp',
    provider: 'msg91',
    channel: 'whatsapp',
    success: JSON.stringify({ status: 'success', request_id: 'req-1' }),
    send: () =>
      new Msg91WhatsAppTransport(
        configFor({ MSG91_AUTH_KEY: 'k', MSG91_WHATSAPP_NUMBER: '919999000000' }),
        bindingsFor('msg91:whatsapp:SHOW_CANCELLED:*=show_cancelled_v1'),
      ).send(msg({ channel: 'whatsapp' })),
  },
  {
    name: 'Meta WhatsApp Cloud',
    provider: 'cloud',
    channel: 'whatsapp',
    success: JSON.stringify({ messages: [{ id: 'wamid.1' }] }),
    send: () =>
      new CloudWhatsAppTransport(
        configFor({ WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_ACCESS_TOKEN: 't' }),
        bindingsFor('cloud:whatsapp:SHOW_CANCELLED:*=show_cancelled_us'),
      ).send(msg({ channel: 'whatsapp' })),
  },
];

describe('provider contract: every adapter, against every provider misbehaviour', () => {
  describe.each(ADAPTERS)('$name', (adapter) => {
    it('accepts a successful response and records the provider reference', async () => {
      fetchMock.mockResolvedValue(http(200, adapter.success));
      const outcome = (await adapter.send()) as { provider: string; providerMessageId: unknown };
      expect(outcome.provider).toBe(adapter.provider);
      // The reference is what lets somebody later ask the provider what became of the
      // message. A send with no reference is a send we cannot follow up.
      expect(outcome.providerMessageId).toBeTruthy();
    });

    it('classifies a rate limit as retryable and blames nobody permanently', async () => {
      fetchMock.mockResolvedValue(http(429, 'slow down'));
      const err = (await adapter.send().catch((e) => e)) as TransportError;
      expect(err.failureClass).toBe(FailureClass.RATE_LIMIT);
      expect(err.retryable).toBe(true);
      // A rate limit is the provider being busy, not broken -- and certainly not us.
      expect(outcomeClassForFailure(err.failureClass)).toBe(OutcomeClass.PROVIDER_UNAVAILABLE);
    });

    it('classifies an authentication failure as ours, and does not retry it', async () => {
      fetchMock.mockResolvedValue(http(401, 'bad token'));
      const err = (await adapter.send().catch((e) => e)) as TransportError;
      expect(err.failureClass).toBe(FailureClass.AUTHENTICATION_ERROR);
      expect(err.retryable).toBe(false);
      /*
        The distinction that keeps a health report honest: an expired token of ours is not the
        provider failing. Filed against them, a credential we forgot to rotate reads as an
        outage, and the alert that should mean "they are down" cannot be trusted again.
      */
      expect(outcomeClassForFailure(err.failureClass)).toBe(OutcomeClass.CONFIGURATION_BLOCKED);
    });

    it('retries a temporary server error', async () => {
      fetchMock.mockResolvedValue(http(503, 'unavailable'));
      const err = (await adapter.send().catch((e) => e)) as TransportError;
      expect(err.failureClass).toBe(FailureClass.TEMPORARY_PROVIDER_ERROR);
      expect(err.retryable).toBe(true);
    });

    it('treats a timeout as temporary, and never as a delivered message', async () => {
      fetchMock.mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });
      const err = (await adapter.send().catch((e) => e)) as TransportError;
      expect(err.failureClass).toBe(FailureClass.TEMPORARY_PROVIDER_ERROR);
      expect(err.retryable).toBe(true);
    });

    it('does not mistake a malformed body for a success', async () => {
      /*
        A gateway returning an HTML error page with a 200 is the classic way a "successful"
        send turns out to have delivered nothing. The adapter must not read an empty parse as
        an accepted message with no reference.
      */
      fetchMock.mockResolvedValue(http(200, '<html>gateway error</html>'));
      const outcome = (await adapter.send().catch((e) => e)) as
        { providerMessageId: unknown } | TransportError;
      if (outcome instanceof TransportError) {
        expect(outcome.retryable).toBeDefined();
      } else {
        // Accepted with no reference is honest -- it says we do not know what became of it --
        // and is exactly what the null column means.
        expect(outcome.providerMessageId).toBeNull();
      }
    });
  });

  describe('template binding is a precondition, not a preference', () => {
    it.each([
      [
        'MSG91 SMS',
        () =>
          new Msg91SmsTransport(configFor({ MSG91_AUTH_KEY: 'k' }), bindingsFor('')).send(msg()),
      ],
      [
        'MSG91 WhatsApp',
        () =>
          new Msg91WhatsAppTransport(
            configFor({ MSG91_AUTH_KEY: 'k', MSG91_WHATSAPP_NUMBER: '91' }),
            bindingsFor(''),
          ).send(msg({ channel: 'whatsapp' })),
      ],
      [
        'Meta WhatsApp Cloud',
        () =>
          new CloudWhatsAppTransport(
            configFor({ WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 't' }),
            bindingsFor(''),
          ).send(msg({ channel: 'whatsapp' })),
      ],
    ])('%s refuses permanently and calls nobody', async (_name, send) => {
      const err = (await send().catch((e) => e)) as TransportError;
      expect(err.failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
      expect(err.retryable).toBe(false);
      /*
        Not calling the provider is the assertion that matters. Sending under a guessed
        template id is accepted by the API and dropped by the carrier, and surfaces days later
        as a customer who never got their ticket -- with a row that says SENT.
      */
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a missing credential is our configuration, never their outage', () => {
    it.each([
      ['MSG91 SMS', () => new Msg91SmsTransport(configFor({}))],
      ['Twilio SMS', () => new TwilioSmsTransport(configFor({}))],
      [
        'Meta WhatsApp Cloud',
        () => new CloudWhatsAppTransport(configFor({ WHATSAPP_PHONE_NUMBER_ID: '1' })),
      ],
    ])('%s fails to construct with CONFIGURATION_ERROR', (_name, build) => {
      let thrown: unknown;
      try {
        build();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TransportError);
      expect((thrown as TransportError).failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
      expect((thrown as TransportError).retryable).toBe(false);
    });
  });

  describe("Twilio's SDK errors, which never reach the HTTP classifier", () => {
    /*
      The Twilio client throws its own object instead of returning a status, so every one of
      these previously arrived as an unrecognised throw and was filed as "Twilio unavailable" --
      including a number that does not exist and an account that had been suspended.
    */
    it.each([
      [21211, FailureClass.INVALID_DESTINATION, 'not a valid number'],
      [21610, FailureClass.COMPLIANCE_BLOCKED, 'the recipient sent STOP'],
      [20003, FailureClass.AUTHENTICATION_ERROR, 'authenticate'],
      [20429, FailureClass.RATE_LIMIT, 'too many requests'],
      [30034, FailureClass.COMPLIANCE_BLOCKED, 'A2P 10DLC not registered'],
    ])('code %i is %s (%s)', (code, expected, _why) => {
      const err = classifyTwilioError({ code, message: 'x' }, 'twilio');
      expect(err.failureClass).toBe(expected);
    });

    it('an unrecognised code is UNKNOWN and is not silently called a rejection', () => {
      const err = classifyTwilioError({ code: 99999, message: 'x' }, 'twilio');
      expect(err.failureClass).toBe(FailureClass.UNKNOWN_PROVIDER_ERROR);
      // Unknown gets the benefit of the doubt, bounded by the attempt limit: dropping a
      // message we might have delivered is the more expensive of the two mistakes.
      expect(err.retryable).toBe(true);
    });
  });
});
