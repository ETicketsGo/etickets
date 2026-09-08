import { ConfigService } from '@nestjs/config';
import { FailureClass, NotificationType } from '@eticketsgo/shared-types';
import { Msg91SmsTransport, parseTemplateIds } from './sms.transport';
import { Msg91WhatsAppTransport, parseTemplateNames } from './whatsapp.transport';
import { TransportError } from './transport-http';
import type { RenderedNotification } from '../notification-channel.interface';

/**
 * The MSG91 adapters, against a mocked HTTP layer.
 *
 * ── WHAT IS NOT PROVED HERE, AND WHY ───────────────────────────────────────────────
 * That MSG91 accepts these requests. Nobody has an MSG91 account, a DLT-registered sender or
 * an approved template, and asserting a live integration from a mock would be asserting
 * something nobody has checked. What IS proved is everything that is ours: that a missing
 * template refuses instead of guessing, that a refusal returned inside an HTTP 200 is treated
 * as a refusal, that a message id comes back, that a timeout is retryable and a bad
 * credential is not, and that the auth key never appears in an error or a log.
 *
 * The account, the sender id and the templates are EXTERNAL SETUP REQUIRED.
 */

const AUTH_KEY = 'msg91-secret-key-do-not-log';

function config(over: Record<string, string> = {}) {
  return new ConfigService({
    MSG91_AUTH_KEY: AUTH_KEY,
    MSG91_WHATSAPP_NUMBER: '919999999999',
    ...over,
  });
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.BOOKING_CANCELLED,
    channel: 'sms',
    locale: 'en',
    subject: 'S',
    body: 'Your show on 12 Sep is cancelled. A refund is on its way.',
    payload: {},
    userId: 'u1',
    destination: '+919876543210',
    ...over,
  };
}

let fetchMock: jest.Mock;
const originalFetch = global.fetch;

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as never);
}

beforeEach(() => {
  fetchMock = jest.fn();
  (global as { fetch: unknown }).fetch = fetchMock;
});
afterAll(() => {
  (global as { fetch: unknown }).fetch = originalFetch;
});

describe('MSG91 SMS', () => {
  const templated = () =>
    new Msg91SmsTransport(
      config({ MSG91_SMS_TEMPLATE_IDS: 'BOOKING_CANCELLED=tmpl-123', MSG91_SENDER_ID: 'ETGGO' }),
    );

  it('refuses permanently when no DLT template is configured for the type', async () => {
    /*
      Not a guess and not a retry. An Indian operator drops a message whose wording is not a
      registered template, so there is nothing to fall back to — and retrying twelve times
      over an hour only delays somebody noticing the registration is missing.
    */
    const err = await new Msg91SmsTransport(config())
      .send(msg())
      .catch((e: unknown) => e as TransportError);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).retryable).toBe(false);
    /*
      Classified, not merely non-retryable. TEMPLATE_NOT_FOUND is what lets an operator
      filter the queue down to "blocked on a template approval" -- and what keeps a missing
      approval out of MSG91's failure rate, where it would look like an outage.
    */
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    // The message names the exact key to set, because that is what makes it actionable.
    expect((err as TransportError).message).toContain('NOTIFICATION_TEMPLATE_BINDINGS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the approved template and returns the provider message id', async () => {
    respond(200, { type: 'success', message: 'req-9f2c' });
    const out = await templated().send(msg());

    expect(out).toEqual({ provider: 'msg91', providerMessageId: 'req-9f2c' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.template_id).toBe('tmpl-123');
    expect(body.sender).toBe('ETGGO');
    // MSG91 wants the number without a leading '+'.
    expect(body.recipients[0].mobiles).toBe('919876543210');
  });

  it('passes structured template variables when the caller supplies them', async () => {
    respond(200, { type: 'success', message: 'req-1' });
    await templated().send(
      msg({ payload: { smsTemplateVars: { ref: 'ETG-IN-2026-0042', show: 'Kalki' } } }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipients[0]).toMatchObject({ ref: 'ETG-IN-2026-0042', show: 'Kalki' });
  });

  it('treats a refusal returned inside an HTTP 200 as a refusal', async () => {
    /*
      MSG91 answers 200 for "no" as well as "yes", saying which in `type`. Believing the
      status code would write SENT for a message the provider had just declined to carry —
      the exact class of lie this phase removed from the status column.
    */
    respond(200, { type: 'error', message: 'template not approved' });
    const err = await templated()
      .send(msg())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).retryable).toBe(false);
    expect((err as TransportError).message).toContain('template not approved');
  });

  it('classifies a bad credential as permanent and an outage as retryable', async () => {
    respond(401, { message: 'invalid authkey' });
    await expect(templated().send(msg())).rejects.toMatchObject({ retryable: false });

    respond(503, { message: 'upstream busy' });
    await expect(templated().send(msg())).rejects.toMatchObject({ retryable: true });

    respond(429, { message: 'slow down' });
    // A rate limit is the request being fine and there being too much of it.
    await expect(templated().send(msg())).rejects.toMatchObject({ retryable: true });
  });

  it('treats a timeout as retryable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(templated().send(msg())).rejects.toMatchObject({ retryable: true });
  });

  it('never puts the auth key in an error', async () => {
    respond(401, { message: 'invalid authkey' });
    const err = await templated()
      .send(msg())
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain(AUTH_KEY);
    // It travels in a header, which is the only place it belongs.
    expect(fetchMock.mock.calls[0][1].headers.authkey).toBe(AUTH_KEY);
  });

  it('skips cleanly with no destination, without calling the provider', async () => {
    const out = await templated().send(msg({ destination: null, userId: 'u1' }));
    expect(out).toMatchObject({ skipped: true, reason: 'no_destination' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes its endpoint from configuration, so a vendor path change is not a deploy', async () => {
    respond(200, { type: 'success', message: 'r' });
    await new Msg91SmsTransport(
      config({
        MSG91_SMS_TEMPLATE_ID: 't',
        MSG91_BASE_URL: 'https://api.msg91.example/',
        MSG91_SMS_PATH: '/v6/send',
      }),
    ).send(msg());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.msg91.example/v6/send');
  });
});

describe('MSG91 WhatsApp', () => {
  const templated = () =>
    new Msg91WhatsAppTransport(
      config({ MSG91_WHATSAPP_TEMPLATES: 'BOOKING_CANCELLED=booking_cancelled_v1' }),
    );

  it('refuses permanently when no approved template is configured', async () => {
    // WhatsApp only allows free text inside a window the recipient opened. A booking notice
    // is business-initiated, so a template is not optional and cannot be invented.
    const err = await new Msg91WhatsAppTransport(config())
      .send(msg({ channel: 'whatsapp' }))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).retryable).toBe(false);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect((err as TransportError).message).toContain('NOTIFICATION_TEMPLATE_BINDINGS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the approved template and returns the request id', async () => {
    respond(200, { status: 'success', request_id: 'wa-77' });
    const out = await templated().send(msg({ channel: 'whatsapp' }));

    expect(out).toEqual({ provider: 'msg91', providerMessageId: 'wa-77' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.integrated_number).toBe('919999999999');
    expect(body.payload.template.name).toBe('booking_cancelled_v1');
    expect(body.payload.template.to_and_components[0].to).toEqual(['919876543210']);
  });

  it('treats a refusal inside an HTTP 200 as a refusal', async () => {
    respond(200, { status: 'error', message: 'number not registered' });
    await expect(templated().send(msg({ channel: 'whatsapp' }))).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe('the template maps', () => {
  it('reads one approved artefact per message type', () => {
    expect(parseTemplateIds('BOOKING_CANCELLED=1,REFUND_COMPLETED=2')).toEqual({
      BOOKING_CANCELLED: '1',
      REFUND_COMPLETED: '2',
    });
    expect(parseTemplateNames('BOOKING_CONFIRMED=conf_v1')).toEqual({
      BOOKING_CONFIRMED: 'conf_v1',
    });
  });

  it('is empty rather than partly wrong when the value is malformed', () => {
    expect(parseTemplateIds('nonsense')).toEqual({});
    expect(parseTemplateIds(undefined)).toEqual({});
  });
});
