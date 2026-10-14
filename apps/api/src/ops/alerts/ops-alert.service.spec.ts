import { Logger } from '@nestjs/common';
import {
  DEFAULT_THROTTLE_MS,
  OpsAlertService,
  parseOpsAlertEmails,
  redactForOps,
  type OpsAlert,
} from './ops-alert.service';
import {
  captureNotAppliedAlert,
  confirmationFailedAlert,
  webhookSignatureAlert,
} from './ops-alert-messages';
import { AppException } from '../../common/errors';

/**
 * The alert service on its own: who is told, how often, and what the message may contain.
 *
 * No real email is sent anywhere in this file. The transport is a recording fake with the
 * same shape as the SES/SendGrid/log transports, and Redis is an in-memory fake that honours
 * the four commands the throttle uses.
 */

type Sent = { toEmail: string; subject: string; body: string; html: unknown };

function fakeTransport(name: 'ses' | 'log' = 'ses', fail = false) {
  const sent: Sent[] = [];
  return {
    sent,
    transport: {
      name,
      send: jest.fn(async (msg: Sent) => {
        if (fail) throw new Error('SES said no to ops@example.com');
        sent.push(msg);
        return { provider: name };
      }),
    },
  };
}

/** Enough of ioredis for SET NX PX / INCR / GETSET / GET, shared between "replicas". */
function fakeRedis(clock: () => number) {
  const store = new Map<string, { v: string; until: number | null }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.until !== null && e.until <= clock()) store.delete(k);
    return store.get(k);
  };
  const client = {
    incr: jest.fn(async (k: string) => {
      const n = Number(live(k)?.v ?? 0) + 1;
      store.set(k, { v: String(n), until: live(k)?.until ?? null });
      return n;
    }),
    pexpire: jest.fn(async (k: string, ms: number) => {
      const e = live(k);
      if (e) e.until = clock() + ms;
      return 1;
    }),
    set: jest.fn(async (k: string, v: string, ...args: unknown[]) => {
      const nx = args.includes('NX');
      const pxIdx = args.indexOf('PX');
      if (nx && live(k)) return null;
      store.set(k, { v, until: pxIdx >= 0 ? clock() + Number(args[pxIdx + 1]) : null });
      return 'OK';
    }),
    getset: jest.fn(async (k: string, v: string) => {
      const old = live(k)?.v ?? null;
      store.set(k, { v, until: live(k)?.until ?? null });
      return old;
    }),
    get: jest.fn(async (k: string) => live(k)?.v ?? null),
  };
  return { client };
}

function brokenRedis() {
  const fail = jest.fn(async () => {
    throw new Error('Connection is closed.');
  });
  return { client: { incr: fail, pexpire: fail, set: fail, getset: fail, get: fail } };
}

function config(values: Record<string, string | undefined>) {
  return { get: (k: string) => values[k] } as never;
}

function make(
  opts: {
    emails?: string;
    appEnv?: string;
    transport?: ReturnType<typeof fakeTransport>['transport'] | null;
    redis?: unknown;
    clock?: { t: number };
  } = {},
) {
  const clock = opts.clock ?? { t: Date.parse('2026-10-14T09:00:00Z') };
  const service = new OpsAlertService(
    config({ OPS_ALERT_EMAILS: opts.emails, APP_ENV: opts.appEnv ?? 'QA' }),
    (opts.transport ?? undefined) as never,
    (opts.redis ?? undefined) as never,
    () => clock.t,
  );
  return { service, clock };
}

const signatureAlert: OpsAlert = webhookSignatureAlert('razorpay', 'evt_1', 812);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('OpsAlertService - not configured', () => {
  it('logs at ERROR, sends nothing, and says why in its status', async () => {
    const { transport } = fakeTransport('ses');
    const { service } = make({ emails: undefined, transport });
    const errorLog = jest.spyOn(Logger.prototype, 'error');

    const result = await service.notify(signatureAlert);

    expect(result).toEqual({ raised: true, count: 1, delivered: 0 });
    expect(transport.send).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('razorpay webhook rejected'));
    const status = await service.status();
    expect(status).toMatchObject({
      configured: false,
      status: 'not_configured',
      recipients: 0,
      emailProvider: 'ses',
    });
    expect(status.reason).toMatch(/OPS_ALERT_EMAILS is not set/);
  });

  it('is not configured when the email provider only logs', async () => {
    const { transport } = fakeTransport('log');
    const { service } = make({ emails: 'ops@eticketsgo.test', transport });
    const status = await service.status();
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/EMAIL_PROVIDER is log/);
  });

  it('warns once at boot when not configured', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    make({}).service.onModuleInit();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Ops alerts are not configured/));
  });
});

describe('OpsAlertService - configured', () => {
  it('emails every recipient a plain-text message with env, kind, ids, time and where to look', async () => {
    const { transport, sent } = fakeTransport('ses');
    const { service } = make({
      emails: 'ops@eticketsgo.test, oncall@eticketsgo.test',
      transport,
      appEnv: 'PRODUCTION',
    });

    const result = await service.notify(signatureAlert);

    expect(result).toEqual({ raised: true, count: 1, delivered: 2 });
    expect(sent.map((s) => s.toEmail)).toEqual(['ops@eticketsgo.test', 'oncall@eticketsgo.test']);
    const [msg] = sent;
    expect(msg.html).toBeNull();
    expect(msg.subject).toBe(
      '[ETicketsGo PRODUCTION] razorpay webhook rejected: signature did not verify',
    );
    expect(msg.body).toContain('Alert type: WEBHOOK_SIGNATURE_REJECTED');
    expect(msg.body).toContain('Environment: PRODUCTION');
    expect(msg.body).toContain('Time (UTC): 2026-10-14T09:00:00.000Z');
    expect(msg.body).toContain('- providerEventId: evt_1');
    expect(msg.body).toContain('Where to look:');
    expect((await service.status()).configured).toBe(true);
  });

  it('records when the last alert fired for the ops health', async () => {
    const { transport } = fakeTransport('ses');
    const { service } = make({ emails: 'ops@eticketsgo.test', transport });
    expect((await service.status()).lastAlertAt).toBeNull();
    await service.notify(signatureAlert);
    expect(await service.status()).toMatchObject({
      lastAlertAt: '2026-10-14T09:00:00.000Z',
      lastAlertKind: 'WEBHOOK_SIGNATURE_REJECTED',
    });
  });
});

describe('OpsAlertService - throttle', () => {
  it('alerts on the first, holds the rest for 15 minutes, then reports the count', async () => {
    const { transport, sent } = fakeTransport('ses');
    const { service, clock } = make({ emails: 'ops@eticketsgo.test', transport });

    expect((await service.notify(signatureAlert)).raised).toBe(true);
    clock.t += 60_000;
    expect((await service.notify(signatureAlert)).raised).toBe(false);
    clock.t += 60_000;
    expect((await service.notify(signatureAlert)).raised).toBe(false);
    expect(sent).toHaveLength(1);

    clock.t += DEFAULT_THROTTLE_MS;
    const next = await service.notify(signatureAlert);
    expect(next).toMatchObject({ raised: true, count: 3 });
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toContain('Occurrences: 3 since the last alert of this type (throttled).');
  });

  it('throttles per provider: Stripe is not silenced by Razorpay', async () => {
    const { transport, sent } = fakeTransport('ses');
    const { service } = make({ emails: 'ops@eticketsgo.test', transport });
    await service.notify(signatureAlert);
    await service.notify(webhookSignatureAlert('stripe', undefined, 10));
    expect(sent.map((s) => s.subject)).toEqual([
      expect.stringContaining('razorpay'),
      expect.stringContaining('stripe'),
    ]);
  });

  it('shares the gate through Redis, so two replicas send one email', async () => {
    const clock = { t: Date.parse('2026-10-14T09:00:00Z') };
    const redis = fakeRedis(() => clock.t);
    const a = fakeTransport('ses');
    const b = fakeTransport('ses');
    const api1 = make({ emails: 'ops@eticketsgo.test', transport: a.transport, redis, clock });
    const api2 = make({ emails: 'ops@eticketsgo.test', transport: b.transport, redis, clock });

    await api1.service.notify(signatureAlert);
    await api2.service.notify(signatureAlert);
    await api2.service.notify(signatureAlert);
    expect(a.sent.length + b.sent.length).toBe(1);

    clock.t += DEFAULT_THROTTLE_MS + 1;
    const r = await api2.service.notify(signatureAlert);
    expect(r).toMatchObject({ raised: true, count: 3 });
    // The last-alert time is shared too: replica 1 sees replica 2's alert.
    expect((await api1.service.status()).lastAlertAt).toBe(new Date(clock.t).toISOString());
  });

  it('falls back to an in-process gate when Redis refuses', async () => {
    const { transport, sent } = fakeTransport('ses');
    const { service } = make({ emails: 'ops@eticketsgo.test', transport, redis: brokenRedis() });
    expect((await service.notify(signatureAlert)).raised).toBe(true);
    expect((await service.notify(signatureAlert)).raised).toBe(false);
    expect(sent).toHaveLength(1);
    await expect(service.status()).resolves.toMatchObject({ lastAlertKind: signatureAlert.kind });
  });
});

describe('OpsAlertService - never throws into the caller', () => {
  it('resolves when the email provider throws', async () => {
    const { transport } = fakeTransport('ses', true);
    const { service } = make({ emails: 'ops@eticketsgo.test', transport, redis: brokenRedis() });
    await expect(service.notify(signatureAlert)).resolves.toMatchObject({
      raised: true,
      delivered: 0,
    });
  });

  it('resolves when rendering itself blows up', async () => {
    const { service } = make({ emails: 'ops@eticketsgo.test' });
    const hostile = {
      ...signatureAlert,
      facts: {
        get bad(): string {
          throw new Error('boom');
        },
      },
    } as unknown as OpsAlert;
    await expect(service.notify(hostile)).resolves.toEqual({
      raised: false,
      count: 0,
      delivered: 0,
    });
  });
});

describe('OpsAlertService - no PII, no secrets', () => {
  it('redacts an email address or phone number wherever it appears', async () => {
    const { transport, sent } = fakeTransport('ses');
    const { service } = make({ emails: 'ops@eticketsgo.test', transport });
    await service.notify({
      kind: 'FINANCE_DISCREPANCY_OPENED',
      key: 'PAYMENT_MISSING_INTERNALLY',
      summary: 'Finance discrepancy opened for buyer ada@example.com',
      facts: {
        detail: 'Captured for ada@example.com, phone +91 98765 43210, booking b1',
        phone: '9876543210',
        bookingId: 'cmabc123',
        amountMinor: 51918,
      },
      where: 'Finance reconciliation',
    });
    const all = `${sent[0].subject}\n${sent[0].body}`;
    expect(all).not.toMatch(/ada@example\.com/);
    expect(all).not.toMatch(/98765/);
    expect(all).not.toMatch(/9876543210/);
    expect(all).toContain('[redacted email]');
    expect(all).toContain('- phone: [redacted]');
    // Ids, amounts and dates are not mistaken for phone numbers.
    expect(all).toContain('- bookingId: cmabc123');
    expect(all).toContain('- amountMinor: 51918');
    expect(all).toContain('2026-10-14T09:00:00.000Z');
  });

  it('a signature alert carries the event id and body size, never the signature or body', () => {
    const alert = webhookSignatureAlert('razorpay', 'evt_9', 1234);
    expect(Object.keys(alert.facts).sort()).toEqual(['bodyBytes', 'provider', 'providerEventId']);
  });

  it('a failed confirmation quotes our own error, but only the class of anyone else', () => {
    const ours = confirmationFailedAlert({
      bookingId: 'b1',
      providerRef: 'pay_1',
      amountMinor: 100,
      error: new AppException('PAYMENT_WEBHOOK_INVALID', 'Paid amount 100 does not match 200.'),
    });
    expect(ours.facts).toMatchObject({ errorCode: 'PAYMENT_WEBHOOK_INVALID' });
    const theirs = confirmationFailedAlert({
      bookingId: 'b1',
      providerRef: 'pay_1',
      amountMinor: 100,
      error: new TypeError('Unique constraint failed on (buyer_email)=(ada@example.com)'),
    });
    expect(theirs.facts).toEqual({
      bookingId: 'b1',
      providerRef: 'pay_1',
      amountMinor: 100,
      errorCode: 'TypeError',
    });
  });

  it('the capture alert names ids and amounts only', () => {
    const alert = captureNotAppliedAlert({
      bookingId: 'b1',
      paymentId: 'p1',
      provider: 'razorpay',
      providerRef: 'pay_1',
      amountMinor: 51918,
      currency: 'INR',
      bookingStatus: 'EXPIRED',
      duplicate: false,
    });
    expect(Object.keys(alert.facts).sort()).toEqual([
      'amountMinor',
      'bookingId',
      'bookingStatus',
      'currency',
      'paymentId',
      'provider',
      'providerRef',
      'reason',
    ]);
  });
});

describe('helpers', () => {
  it('parses a comma-separated list and drops anything that is not an address', () => {
    expect(parseOpsAlertEmails(' a@x.io, ,not-an-address, b@y.co ')).toEqual(['a@x.io', 'b@y.co']);
    expect(parseOpsAlertEmails(undefined)).toEqual([]);
  });

  it('keeps one line and caps length', () => {
    expect(redactForOps('a\nb')).toBe('a b');
    expect(redactForOps('x'.repeat(400))).toHaveLength(303);
  });
});
