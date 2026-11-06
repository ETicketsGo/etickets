import type { ErrorEvent } from '@sentry/core';
import {
  redactText,
  redactValue,
  scrubBreadcrumb,
  scrubSensitiveData,
  resolveSentryRelease,
} from './sentry';
import { requestArea } from '../common/all-exceptions.filter';
import { opsAlertToSentry } from '../ops/alerts/ops-alert-sentry.bridge';
import { webhookDeadLetteredAlert } from '../ops/alerts/ops-alert-messages';

/**
 * What may never reach Sentry, whatever produced the event: payment data, OTPs, passwords,
 * tokens, and the customer's contact details. Each case below is a string the platform could
 * plausibly put in an exception message, a breadcrumb or `extra`.
 */
describe('free-text redaction', () => {
  it.each([
    ['No user with email asha.k@example.com', 'asha.k@example.com'],
    ['UPI collect failed for asha@okicici', 'asha@okicici'],
    ['Card 4111 1111 1111 1111 declined', '4111 1111 1111 1111'],
    ['card 4111-1111-1111-1111', '4111-1111-1111-1111'],
    ['SMS to +91 98450 12345 failed', '98450 12345'],
    ['SMS to +14695551234 failed', '+14695551234'],
    ['phone 9845012345 not verified', '9845012345'],
    ['OTP 482913 expired', '482913'],
    ['code: 1234 wrong', '1234'],
    ['Authorization: Bearer abc.def-ghi', 'abc.def-ghi'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part-1 rejected', 'eyJhbGciOiJIUzI1NiJ9'],
  ])('%s', (text, secret) => {
    const out = redactText(text);
    expect(out).not.toContain(secret);
  });

  it('keeps what an engineer needs: ids, amounts, statuses, dates', () => {
    const text =
      'booking cmfz8k2j00001abcd payment pay_Nk3s9 amount 52282 status CAPTURED at 2026-11-06T06:21:28Z';
    expect(redactText(text)).toBe(text);
  });
});

describe('structured redaction', () => {
  it('replaces sensitive keys whatever their value, at any depth', () => {
    const out = redactValue({
      bookingId: 'b1',
      customer: { email: 'x@y.com', phone: '+15555550100', name: 'kept' },
      payment: { card: '4111111111111111', vpa: 'a@okaxis', upi_id: 'a@ybl', amountMinor: 100 },
      auth: { password: 'p', otp: '123456', refreshToken: 'r', apiKey: 'k' },
    }) as Record<string, Record<string, unknown>>;
    expect(out.bookingId).toBe('b1');
    expect(out.customer).toEqual({ email: '[redacted]', phone: '[redacted]', name: 'kept' });
    expect(out.payment).toMatchObject({ card: '[redacted]', vpa: '[redacted]', amountMinor: 100 });
    expect(Object.values(out.auth)).toEqual(Array(4).fill('[redacted]'));
  });
});

describe('scrubSensitiveData covers every part of an event', () => {
  it('message, exception values, extra, contexts and breadcrumbs', () => {
    const event = {
      message: 'login failed for a@b.com',
      exception: { values: [{ type: 'Error', value: 'OTP 998877 for +919845012345 expired' }] },
      extra: { email: 'a@b.com', note: 'card 4111 1111 1111 1111' },
      contexts: { runtime: { name: 'node', version: 'v24' }, payment: { vpa: 'z@okhdfc' } },
      breadcrumbs: [{ message: 'sent to c@d.com', data: { phone: '+15555550100' } }],
      user: { email: 'a@b.com' },
    } as unknown as ErrorEvent;
    const out = JSON.stringify(scrubSensitiveData(event));
    for (const secret of [
      'a@b.com',
      '998877',
      '9845012345',
      '4111',
      'z@okhdfc',
      'c@d.com',
      '5555550100',
    ]) {
      expect(out).not.toContain(secret);
    }
    // The runtime context is Sentry's own and is kept as is.
    expect(out).toContain('"version":"v24"');
  });

  it('a breadcrumb on its own is scrubbed too', () => {
    const crumb = scrubBreadcrumb({ message: 'GET /x?email=a@b.com', data: { token: 't' } });
    expect(JSON.stringify(crumb)).not.toMatch(/a@b\.com|"t"/);
  });
});

describe('release', () => {
  it('a promoted image reports the commit it was built from (GIT_SHA)', () => {
    expect(resolveSentryRelease({ GIT_SHA: 'abc123' } as NodeJS.ProcessEnv)).toBe('abc123');
    expect(
      resolveSentryRelease({ SENTRY_RELEASE: 'v1', GIT_SHA: 'abc' } as NodeJS.ProcessEnv),
    ).toBe('v1');
  });
});

describe('request area (grouping and alert routing)', () => {
  it.each([
    ['/api/payments/webhooks/razorpay', 'payments.webhook'],
    ['/api/payments/razorpay/order', 'payments'],
    ['/api/bookings/quote', 'checkout'],
    ['/api/bookings', 'checkout'],
    ['/api/refunds/abc/approve', 'refunds'],
    ['/api/admin/payouts/1/pay', 'payouts'],
    ['/api/auth/login', 'auth'],
    ['/api/admin/fee-schedules/INR', 'admin'],
    ['/api/public/discovery', 'other'],
  ])('%s -> %s', (path, area) => {
    expect(requestArea(path)).toBe(area);
  });
});

describe('ops alerts become Sentry issues', () => {
  it('a dead-lettered webhook is an error, grouped by kind and key, with no person in it', () => {
    const alert = webhookDeadLetteredAlert({
      provider: 'razorpay',
      webhookEventId: 'we_1',
      providerEventId: 'evt_1',
      eventType: 'payment.captured',
      attempts: 8,
    });
    const event = opsAlertToSentry(alert);
    expect(event.level).toBe('error');
    expect(event.fingerprint).toEqual(['ops-alert', 'WEBHOOK_DEAD_LETTERED', alert.key]);
    expect(event.tags).toEqual({ alert_kind: 'WEBHOOK_DEAD_LETTERED', area: 'payments.webhook' });
    expect(event.extra).toMatchObject({ provider: 'razorpay' });
  });
});
