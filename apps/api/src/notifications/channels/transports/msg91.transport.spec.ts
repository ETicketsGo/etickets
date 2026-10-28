import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FailureClass, NotificationType } from '@eticketsgo/shared-types';
import { Msg91SmsTransport, indianMobileDigits, parseTemplateIds } from './sms.transport';
import { Msg91WhatsAppTransport, parseTemplateNames } from './whatsapp.transport';
import { TransportError } from './transport-http';
import type { RenderedNotification } from '../notification-channel.interface';
import {
  DLT_SMS_REPLACEMENTS,
  DLT_SMS_TEMPLATES,
  matchDltSms,
  renderDltSms,
  type DltSmsTemplate,
} from '../../templates/dlt-sms-templates';

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
  /*
    A complete India setup for BOOKING_CANCELLED: the approved header, MSG91's id for the
    template, and the DLT approval recorded alongside it. Ids are invented shapes, not real.
  */
  const READY = {
    MSG91_SENDER_ID: 'DPTRCS',
    DLT_SENDER_HEADER: 'DPTRCS',
    MSG91_SMS_TEMPLATE_BOOKING_CANCELLED: 'tmpl-123',
    DLT_TEMPLATE_ID_BOOKING_CANCELLED: '1707000000000000001',
  };
  const templated = (over: Record<string, string> = {}) =>
    new Msg91SmsTransport(config({ ...READY, ...over }));
  const cancelled = (over: Partial<RenderedNotification> = {}) =>
    msg({ payload: { reference: 'ETG-IN-2026-000042' }, ...over });

  it('refuses permanently when no DLT template is configured for the type', async () => {
    /*
      Not a guess and not a retry. An Indian operator drops a message whose wording is not a
      registered template, so there is nothing to fall back to — and retrying twelve times
      over an hour only delays somebody noticing the registration is missing.
    */
    const err = await new Msg91SmsTransport(config({ MSG91_SENDER_ID: 'DPTRCS' }))
      .send(cancelled())
      .catch((e: unknown) => e as TransportError);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).retryable).toBe(false);
    /*
      Classified, not merely non-retryable. TEMPLATE_NOT_FOUND is what lets an operator
      filter the queue down to "blocked on a template approval" -- and what keeps a missing
      approval out of MSG91's failure rate, where it would look like an outage.
    */
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    // The message names the exact keys to set, because that is what makes it actionable.
    expect((err as TransportError).message).toContain('MSG91_SMS_TEMPLATE_BOOKING_CANCELLED');
    expect((err as TransportError).message).toContain('DLT_TEMPLATE_ID_BOOKING_CANCELLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the DLT approval is not recorded', { DLT_TEMPLATE_ID_BOOKING_CANCELLED: '' }],
    ['the DLT id is not 19 digits', { DLT_TEMPLATE_ID_BOOKING_CANCELLED: '17070000' }],
    ['MSG91 has no id for it', { MSG91_SMS_TEMPLATE_BOOKING_CANCELLED: '' }],
  ])('refuses, calling nobody, when %s', async (_why, over) => {
    const err = await templated(over)
      .send(cancelled())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a type with no registered DLT wording, whatever ids are configured', async () => {
    /*
      PAYMENT_FAILED has no registered SMS text. The old fallback (MSG91_SMS_TEMPLATE_ID) would
      have sent it under some other type's template -- accepted by MSG91, dropped by the carrier.
    */
    const err = await templated({ MSG91_SMS_TEMPLATE_ID: 'tmpl-any' })
      .send(cancelled({ type: NotificationType.PAYMENT_FAILED }))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect((err as TransportError).message).toContain('no registered DLT wording');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses with no sender header, and never invents one', async () => {
    const err = await templated({ MSG91_SENDER_ID: '', DLT_SENDER_HEADER: '' })
      .send(cancelled())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
    expect((err as TransportError).message).toContain('DLT_SENDER_HEADER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Owner, 2026-10-25: header ETKTGO is approved, so it is sent under, not refused.
  it('accepts ETKTGO when configured with valid ids', async () => {
    respond(200, { type: 'success', message: 'req-etktgo' });
    const out = await templated({ MSG91_SENDER_ID: 'ETKTGO', DLT_SENDER_HEADER: 'ETKTGO' }).send(
      cancelled(),
    );
    expect(out).toEqual({ provider: 'msg91', providerMessageId: 'req-etktgo' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.sender).toBe('ETKTGO');
  });

  it('still refuses ETKTGO, calling nobody, when its template ids are missing', async () => {
    const err = await templated({
      MSG91_SENDER_ID: 'ETKTGO',
      DLT_SENDER_HEADER: 'ETKTGO',
      DLT_TEMPLATE_ID_BOOKING_CANCELLED: '',
    })
      .send(cancelled())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the approved template, its variables by name, and returns the request id', async () => {
    respond(200, { type: 'success', message: 'req-9f2c' });
    const out = await templated().send(cancelled());

    expect(out).toEqual({ provider: 'msg91', providerMessageId: 'req-9f2c' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.template_id).toBe('tmpl-123');
    expect(body.sender).toBe('DPTRCS');
    // Exactly the registered variables: no `body`, nothing a payload smuggled in.
    expect(body.recipients[0]).toEqual({
      mobiles: '919876543210',
      reference: 'ETG-IN-2026-000042',
    });
  });

  it('ignores free-form variables in the payload: the registry decides what is sent', async () => {
    respond(200, { type: 'success', message: 'req-1' });
    await templated().send(
      cancelled({
        payload: { reference: 'ETG-IN-2026-000042', smsTemplateVars: { body: 'anything' } },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipients[0]).not.toHaveProperty('body');
  });

  it('refuses a payload missing a variable rather than sending a blank', async () => {
    const err = await templated()
      .send(cancelled({ payload: {} }))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
    expect((err as TransportError).message).toContain('reference');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('the sign-in code', () => {
    const OTP = {
      MSG91_SENDER_ID: 'DPTRCS',
      MSG91_SMS_TEMPLATE_OTP: 'tmpl-otp',
      DLT_TEMPLATE_ID_OTP: '1707000000000000009',
    };
    const otp = (body: string) =>
      msg({ type: 'ACCOUNT_SECURITY' as never, body, payload: { phone: '+919876543210' } });

    it('reads the code and minutes back out of the registered wording', async () => {
      respond(200, { type: 'success', message: 'req-otp' });
      await new Msg91SmsTransport(config(OTP)).send(
        otp(
          '042917 is your ETicketsGo sign-in code. It expires in 10 minutes. Never share it with anyone.',
        ),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.template_id).toBe('tmpl-otp');
      expect(body.recipients[0]).toEqual({
        mobiles: '919876543210',
        otp: '042917',
        minutes: '10',
      });
    });

    it('refuses different wording without ever repeating the code', async () => {
      const err = await new Msg91SmsTransport(config(OTP))
        .send(otp('Your code is 042917'))
        .catch((e: unknown) => e as TransportError);
      expect((err as TransportError).failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
      expect((err as TransportError).message).not.toContain('042917');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('still reads the legacy per-type map for the MSG91 id', async () => {
    respond(200, { type: 'success', message: 'r' });
    await new Msg91SmsTransport(
      config({
        MSG91_SENDER_ID: 'DPTRCS',
        MSG91_SMS_TEMPLATE_IDS: 'BOOKING_CANCELLED=tmpl-legacy',
        DLT_TEMPLATE_ID_BOOKING_CANCELLED: '1707000000000000001',
      }),
    ).send(cancelled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe('tmpl-legacy');
  });

  it('treats a refusal returned inside an HTTP 200 as a refusal, without the number', async () => {
    /*
      MSG91 answers 200 for "no" as well as "yes", saying which in `type`. Believing the
      status code would write SENT for a message the provider had just declined to carry.
    */
    respond(200, { type: 'error', message: 'template not approved for 919876543210' });
    const err = await templated()
      .send(cancelled())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).retryable).toBe(false);
    expect((err as TransportError).message).toContain('template not approved');
    expect((err as TransportError).message).not.toContain('919876543210');
  });

  it('classifies a bad credential as permanent and an outage as retryable', async () => {
    respond(401, { message: 'invalid authkey' });
    await expect(templated().send(cancelled())).rejects.toMatchObject({ retryable: false });

    respond(503, { message: 'upstream busy' });
    await expect(templated().send(cancelled())).rejects.toMatchObject({ retryable: true });

    respond(429, { message: 'slow down' });
    // A rate limit is the request being fine and there being too much of it.
    await expect(templated().send(cancelled())).rejects.toMatchObject({ retryable: true });
  });

  it('treats a timeout as retryable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(templated().send(cancelled())).rejects.toMatchObject({ retryable: true });
  });

  it('never puts the auth key in an error', async () => {
    respond(401, { message: 'invalid authkey' });
    const err = await templated()
      .send(cancelled())
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain(AUTH_KEY);
    // It travels in a header, which is the only place it belongs.
    expect(fetchMock.mock.calls[0][1].headers.authkey).toBe(AUTH_KEY);
  });

  it('skips cleanly with no destination, without calling the provider', async () => {
    const out = await templated().send(cancelled({ destination: null, userId: 'u1' }));
    expect(out).toMatchObject({ skipped: true, reason: 'no_destination' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes its endpoint from configuration, so a vendor path change is not a deploy', async () => {
    respond(200, { type: 'success', message: 'r' });
    await templated({
      MSG91_BASE_URL: 'https://api.msg91.example/',
      MSG91_SMS_PATH: '/v6/send',
    }).send(cancelled());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.msg91.example/v6/send');
  });
});

/*
  The show-cancelled text, chosen per reader (owner, 2026-10-16). The registered wording tells
  the buyer to check their email for refund details, which is false for a cash buyer. Corrected
  wording waits for DLT approval, and until its ids are set nothing changes for an online buyer.
*/
describe('MSG91 SMS: show cancelled, online and cash', () => {
  const REGISTERED = {
    MSG91_SENDER_ID: 'DPTRCS',
    DLT_SENDER_HEADER: 'DPTRCS',
    MSG91_SMS_TEMPLATE_SHOW_CANCELLED: 'tmpl-show',
    DLT_TEMPLATE_ID_SHOW_CANCELLED: '1707000000000000010',
  };
  const ONLINE_APPROVED = {
    MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE: 'tmpl-show-online',
    DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE: '1707000000000000020',
  };
  const CASH_APPROVED = {
    MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH: 'tmpl-show-cash',
    DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH: '1707000000000000021',
  };
  const ONLINE = {
    reference: 'ETG-IN-2026-000042',
    eventTitle: 'Kalki 2898 AD',
    startsAt: '2026-11-01T13:30:00.000Z',
    timeZone: 'Asia/Kolkata',
  };
  const CASH = { ...ONLINE, paidInCash: true, amountMinor: 165036, currency: 'INR' };
  const transport = (over: Record<string, string> = {}) =>
    new Msg91SmsTransport(config({ ...REGISTERED, ...over }));
  const show = (payload: Record<string, unknown>) =>
    msg({ type: NotificationType.SHOW_CANCELLED, payload });

  /** What the operator will read, rebuilt from the request: MSG91 fills the template by name. */
  function sentText(template: DltSmsTemplate): string {
    const recipient = JSON.parse(fetchMock.mock.calls[0][1].body).recipients[0];
    expect(Object.keys(recipient).sort()).toEqual(['mobiles', ...template.variables].sort());
    const text = renderDltSms(
      template,
      template.variables.map((name) => recipient[name]),
    );
    // The guard: what goes out is an instance of the registered wording, or it is not sent.
    expect(matchDltSms(template, text)).not.toBeNull();
    return text;
  }
  const replacement = (key: string) =>
    DLT_SMS_REPLACEMENTS.find((r) => r.dltTemplateIdEnv === key) as DltSmsTemplate;

  it('with the new ids unset, an online buyer gets the registered template exactly as before', async () => {
    respond(200, { type: 'success', message: 'req-1' });
    await transport().send(show(ONLINE));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.template_id).toBe('tmpl-show');
    expect(sentText(DLT_SMS_TEMPLATES[NotificationType.SHOW_CANCELLED])).toBe(
      'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. Check your email for refund details. - DeepTrics',
    );
  });

  it('with the cash id unset, a cash buyer is sent nothing, and the refusal names the keys', async () => {
    const err = await transport(ONLINE_APPROVED)
      .send(show(CASH))
      .catch((e: unknown) => e as TransportError);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect((err as TransportError).retryable).toBe(false);
    expect((err as TransportError).message).toContain('DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('once the cash wording is approved, a cash buyer gets it, with the amount', async () => {
    respond(200, { type: 'success', message: 'req-2' });
    await transport(CASH_APPROVED).send(show(CASH));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.template_id).toBe('tmpl-show-cash');
    expect(sentText(replacement('DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH'))).toBe(
      'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. You paid Rs 1650.36 in cash. Show this booking at the venue box office to get your cash back. - DeepTrics',
    );
  });

  it('the cash wording does not touch an online buyer', async () => {
    respond(200, { type: 'success', message: 'req-3' });
    await transport(CASH_APPROVED).send(show(ONLINE));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe('tmpl-show');
  });

  it('once the online wording is approved, an online buyer gets it', async () => {
    respond(200, { type: 'success', message: 'req-4' });
    await transport({ ...ONLINE_APPROVED, ...CASH_APPROVED }).send(show(ONLINE));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe('tmpl-show-online');
    expect(sentText(replacement('DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE'))).toBe(
      'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. Your refund will go to the account you paid from. - DeepTrics',
    );
  });

  it('an approved DLT id with no MSG91 id refuses; it never borrows the old template id', async () => {
    /*
      A binding keyed by type names the OLD template. Sending the cash variables under it would
      put wording on the wire that nobody approved for this reader.
    */
    const err = await transport({
      DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH: '1707000000000000021',
      MSG91_SMS_TEMPLATE_IDS: 'SHOW_CANCELLED=tmpl-old',
    })
      .send(show(CASH))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect((err as TransportError).message).toContain('MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the organization copy of a walk-up message is never texted', async () => {
    const err = await transport({ ...ONLINE_APPROVED, ...CASH_APPROVED })
      .send(show({ ...CASH, cashRecipient: 'ORGANIZER', buyerName: 'Walk Buyer' }))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a cash booking with no amount is refused rather than sent with a blank', async () => {
    const err = await transport(CASH_APPROVED)
      .send(show({ ...ONLINE, paidInCash: true }))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
    expect((err as TransportError).message).toContain('amount');
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('MSG91 SMS: India numbers and the non-production recipient guard', () => {
  const READY = {
    MSG91_SENDER_ID: 'ETKTGO',
    DLT_SENDER_HEADER: 'ETKTGO',
    MSG91_SMS_TEMPLATE_BOOKING_CANCELLED: 'tmpl-123',
    DLT_TEMPLATE_ID_BOOKING_CANCELLED: '1707000000000000001',
  };
  const cancelled = (over: Partial<RenderedNotification> = {}) =>
    msg({ payload: { reference: 'ETG-IN-2026-000042' }, ...over });

  it.each([
    ['+919876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['+91 98765-43210', '919876543210'],
    ['+916000000000', '916000000000'],
  ])('normalises %s to %s', (input, out) => {
    expect(indianMobileDigits(input)).toBe(out);
  });

  it.each([
    ['a landline', '+914023456789'],
    ['a mobile starting 5', '+915876543210'],
    ['a bare ten-digit number', '9876543210'],
    ['too short', '+91987654321'],
    ['a US number', '+12025550123'],
  ])('refuses %s permanently, calling nobody', async (_why, destination) => {
    const err = await new Msg91SmsTransport(config(READY))
      .send(cancelled({ destination }))
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.INVALID_DESTINATION);
    expect((err as TransportError).retryable).toBe(false);
    // The number never appears whole in the error.
    expect((err as TransportError).message).not.toContain(destination.replace(/^\+/, ''));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PRODUCTION has no gate: an Indian mobile is sent to MSG91', async () => {
    respond(200, { type: 'success', message: 'req-1' });
    const out = await new Msg91SmsTransport(config({ ...READY, APP_ENV: 'PRODUCTION' })).send(
      cancelled(),
    );
    expect(out).toEqual({ provider: 'msg91', providerMessageId: 'req-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['QA', 'UAT', 'LOCAL'])(
    '%s with an empty allowlist sends nothing and answers as log mode',
    async (env) => {
      const out = await new Msg91SmsTransport(config({ ...READY, APP_ENV: env })).send(cancelled());
      expect(out).toEqual({ provider: 'log' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('QA sends to an allowlisted number only', async () => {
    respond(200, { type: 'success', message: 'req-2' });
    const transport = new Msg91SmsTransport(
      config({
        ...READY,
        APP_ENV: 'QA',
        SMS_TEST_RECIPIENT_ALLOWLIST: ' +91 98765-43210 , not-a-number,+919000000001',
      }),
    );
    const allowed = await transport.send(cancelled());
    expect(allowed).toEqual({ provider: 'msg91', providerMessageId: 'req-2' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.recipients[0].mobiles).toBe('919876543210');
    expect(body.sender).toBe('ETKTGO');

    const other = await transport.send(cancelled({ destination: '+919812345678' }));
    expect(other).toEqual({ provider: 'log' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the guard runs after the template checks, so QA still proves the mapping', async () => {
    const err = await new Msg91SmsTransport(
      config({ ...READY, APP_ENV: 'QA', DLT_TEMPLATE_ID_BOOKING_CANCELLED: '' }),
    )
      .send(cancelled())
      .catch((e: unknown) => e as TransportError);
    expect((err as TransportError).failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
  });

  it('the guard log line masks the number and never carries the code or the key', async () => {
    const logs: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      await new Msg91SmsTransport(
        config({
          ...READY,
          APP_ENV: 'QA',
          MSG91_SMS_TEMPLATE_OTP: 'tmpl-otp',
          DLT_TEMPLATE_ID_OTP: '1707000000000000009',
        }),
      ).send(
        msg({
          type: 'ACCOUNT_SECURITY' as never,
          body: '482913 is your ETicketsGo sign-in code. It expires in 10 minutes. Never share it with anyone.',
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const all = logs.join('\n');
    expect(all).toContain('SMS_TEST_RECIPIENT_ALLOWLIST');
    expect(all).not.toContain('482913');
    expect(all).not.toContain('9876543210');
    expect(all).not.toContain(AUTH_KEY);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
