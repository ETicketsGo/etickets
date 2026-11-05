import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhoneOtpService } from './phone-otp.service';
import { SmsChannel } from '../notifications/channels/sms.channel';
import { NotificationProviderResolver } from '../notifications/channels/notification-provider.resolver';
import { TemplateBindingService } from '../notifications/templates/template-binding.service';
import {
  DLT_SMS_TEMPLATES,
  OTP_SMS_KIND,
  matchDltSms,
  renderDltSms,
} from '../notifications/templates/dlt-sms-templates';
import { withTransactions } from './test-support/otp-sms-memory-store';
import * as dltRegistry from '../notifications/templates/dlt-sms-templates';

/**
 * A sign-in code to an Indian number, through the real chain, once DLT is approved.
 *
 * Config, resolver, channel, MSG91 transport and the OTP service are all real; only the
 * database and the network are mocked. `fetch` is a mock, so nothing leaves the process and no
 * credential exists: the ids and the key below are invented shapes.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * That configuration alone turns phone sign-in on: the request names the configured template
 * and header, carries the code and minutes as the registered variables, and the text those
 * variables produce is the registered wording. And that the code reaches the request and
 * nothing else -- not a log line, not an error.
 */

const APPROVED = {
  APP_ENV: 'PRODUCTION',
  NODE_ENV: 'production',
  NOTIFICATION_MARKETS: 'IN',
  SMS_PROVIDER_BY_MARKET: 'IN=msg91',
  MSG91_AUTH_KEY: 'invented-test-key',
  DLT_SENDER_HEADER: 'DPTRCS',
  MSG91_SENDER_ID: 'DPTRCS',
  MSG91_SMS_TEMPLATE_OTP: 'tmpl-otp-invented',
  DLT_TEMPLATE_ID_OTP: '1707000000000000009',
};

function build(values: Record<string, string | undefined>) {
  const config = new ConfigService(values);
  const resolver = new NotificationProviderResolver(config, new TemplateBindingService(config));
  const sms = new SmsChannel(resolver);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = withTransactions({
    phoneOtp: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'otp-new' }),
      updateMany,
    },
  });
  return { service: new PhoneOtpService(prisma as never, sms, config), updateMany };
}

/*
  The approved templates' registered text is not verified yet, so every kind is refused at the
  approval gate today. The tests in this file prove the pipeline BEHIND that gate, as it will
  run once a template is verified; the gate itself is proved in dlt-sms-templates.spec.ts and
  in 'MSG91 SMS: only approved, verified templates send'.
*/
beforeEach(() => {
  jest.spyOn(dltRegistry, 'dltSendRefusal').mockReturnValue(null);
});

describe('phone sign-in over MSG91 with DLT approved', () => {
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  let logged: string[];

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ type: 'success', message: 'req-otp-1' }),
    });
    (global as { fetch: unknown }).fetch = fetchMock;
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    (global as { fetch: unknown }).fetch = originalFetch;
  });

  it('sends the registered template with the code as its MSG91 variable', async () => {
    const { service } = build(APPROVED);
    await expect(service.requestCode('+919704464007')).resolves.toEqual({
      sent: true,
      expiresInMinutes: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.template_id).toBe('tmpl-otp-invented');
    expect(body.sender).toBe('DPTRCS');
    const [recipient] = body.recipients;
    expect(recipient.mobiles).toBe('919704464007');
    expect(recipient.num).toMatch(/^\d{6}$/);
    expect(Object.keys(recipient).sort()).toEqual(['mobiles', 'num']);

    // What the operator will compare: the registered wording, filled in order.
    const template = DLT_SMS_TEMPLATES[OTP_SMS_KIND];
    const text = renderDltSms(template, [recipient.num]);
    expect(matchDltSms(template, text)).toEqual([recipient.num]);

    // The code went to MSG91 and nowhere else; the number only masked.
    const all = logged.join('\n');
    expect(all).not.toContain(recipient.num);
    expect(all).not.toContain('9704464007');
    expect(all).toContain('req-otp-1');
  });

  it("keeps MSG91's request id on the code's row, so the delivery report can find it", async () => {
    const { service, updateMany } = build(APPROVED);
    await service.requestCode('+919704464007');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'otp-new' },
      data: { provider: 'msg91', providerMessageId: 'req-otp-1', deliveryStatus: 'ACCEPTED' },
    });
    // The code and the number stay out of the log while doing so.
    const num = JSON.parse(fetchMock.mock.calls[0][1].body).recipients[0].num;
    const all = logged.join('\n');
    expect(all).not.toContain(num);
    expect(all).not.toContain('9704464007');
  });

  it('refuses, consumes the code and calls nobody when the OTP template is not approved', async () => {
    const { service, updateMany } = build({ ...APPROVED, DLT_TEMPLATE_ID_OTP: undefined });
    await expect(service.requestCode('+919704464007')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('email address'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const last = updateMany.mock.calls[updateMany.mock.calls.length - 1][0];
    expect(last.data.consumedAt).toBeInstanceOf(Date);
  });

  it('refuses a custom OTP text that is not the registered wording, without logging it', async () => {
    const { service } = build({ ...APPROVED, OTP_SMS_TEMPLATE: 'Your code is {code}' });
    await expect(service.requestCode('+919704464007')).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.join('\n')).not.toMatch(/Your code is \d{6}/);
  });
});
