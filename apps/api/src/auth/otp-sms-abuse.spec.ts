import { MetricsService } from '../metrics/metrics.service';
import type { OpsAlert } from '../ops/alerts/ops-alert.service';
import { PhoneOtpService } from './phone-otp.service';
import { OtpSmsGuard } from './otp-sms-guard';
import { MemoryOtpSmsCounterStore, withTransactions } from './test-support/otp-sms-memory-store';

/**
 * unit - SMS pumping and OTP flooding, end to end through `requestCode`.
 *
 * ── WHAT THESE PROVE ───────────────────────────────────────────────────────────────
 * The request-code endpoint is public and each request is a text message we pay for. These
 * drive the real service, the real guard and the real destination rule, with an in-memory
 * store that behaves as the Redis script does (`test-support/otp-sms-memory-store.ts`; the real
 * script is held to the same behaviour in `otp-sms-guard.integration.spec.ts`). Only the SMS
 * provider and the database are stand-ins.
 *
 * The concurrency tests fire their requests with `Promise.all`, so every request is in flight
 * before any finishes - the condition the old count-then-insert limit could not survive.
 */

/*
  bcrypt is replaced by an instant stand-in here (hashing is proven in phone-otp.service.spec).
  A real bcrypt round takes tens of milliseconds and staggers concurrent requests, which would
  let a NON-atomic limiter pass a concurrency test by luck: every request would arrive after
  the one before it had finished. Instant hashing makes them all arrive together.
*/
jest.mock('bcryptjs', () => ({
  hash: async () => '$2a$10$stand-in-hash',
  compare: async () => false,
}));

const T0 = Date.parse('2026-10-21T08:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Row = { phone: string; createdAt: Date; consumedAt: Date | null; requestedIp: string | null };

/**
 * A `PhoneOtp` table good enough for the limiter: `count` honours `phone` and `createdAt.gte`,
 * `create` stamps the clock's time. Its `$transaction` runs one at a time, as the advisory
 * lock makes real transactions do, so a fallback that did its check OUTSIDE the transaction
 * would be caught by the concurrency test below.
 */
function database(now: () => number) {
  const rows: Row[] = [];
  type Where = { phone?: string; createdAt?: { gte?: Date; gt?: Date } };
  const matches = (row: Row, where: Where) =>
    (where.phone === undefined || row.phone === where.phone) &&
    (where.createdAt?.gte === undefined || row.createdAt >= where.createdAt.gte) &&
    (where.createdAt?.gt === undefined || row.createdAt > where.createdAt.gt);
  const prisma = withTransactions({
    phoneOtp: {
      count: jest.fn(async ({ where }: { where: Where }) => {
        await Promise.resolve();
        return rows.filter((r) => matches(r, where)).length;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'createdAt' | 'consumedAt'> }) => {
        await Promise.resolve();
        rows.push({ ...data, createdAt: new Date(now()), consumedAt: null });
        return { id: `otp-${rows.length}` };
      }),
    },
    user: { findUnique: jest.fn(async () => null) },
  });
  // Serialise transactions, as `pg_advisory_xact_lock` does.
  let chain: Promise<unknown> = Promise.resolve();
  const run = prisma.$transaction;
  prisma.$transaction = <R>(fn: (tx: never) => Promise<R>): Promise<R> => {
    const next = chain.then(() => run(fn as never) as Promise<R>);
    chain = next.catch(() => undefined);
    return next;
  };
  return { prisma, rows };
}

function setup(
  over: {
    env?: Record<string, string | undefined>;
    redisDown?: boolean;
    noStore?: boolean;
  } = {},
) {
  let clock = T0;
  const now = () => clock;
  const env: Record<string, string | undefined> = {
    APP_ENV: 'PRODUCTION',
    JWT_ACCESS_SECRET: 'test-secret-for-hmac',
    ...over.env,
  };
  const config = { get: (k: string) => env[k] };
  const store = new MemoryOtpSmsCounterStore(now);
  store.down = over.redisDown ?? false;
  const alerts: OpsAlert[] = [];
  const opsAlerts = {
    notify: jest.fn(async (a: OpsAlert) => {
      alerts.push(a);
      return { raised: true, count: 1, delivered: 0 };
    }),
  };
  const guard = new OtpSmsGuard(
    config as never,
    undefined,
    opsAlerts as never,
    over.noStore ? undefined : store,
    now,
  );
  const { prisma, rows } = database(now);
  const sms = {
    deliver: jest.fn(async () => {
      await Promise.resolve();
      return { provider: 'twilio' };
    }),
  };
  const metrics = new MetricsService();
  const service = new PhoneOtpService(
    prisma as never,
    sms as never,
    config as never,
    guard,
    metrics,
  );
  return {
    service,
    sms,
    prisma,
    rows,
    store,
    alerts,
    metrics,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const INDIA = '+919704464007';
const US = '+14155550132';

/** Distinct, valid Indian mobile numbers. */
const indianNumber = (i: number) => `+9198${String(10_000_000 + i).slice(-8)}`;

async function settle(promises: Promise<unknown>[]) {
  const results = await Promise.allSettled(promises);
  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as { status?: number; code?: string; message?: string });
  return { sent, errors };
}

describe('sign-in codes: per-number limits', () => {
  it('lets a real person ask, wait out the cooldown, and ask again', async () => {
    const { service, sms, advance } = setup();
    await expect(service.requestCode(INDIA)).resolves.toMatchObject({ sent: true });

    // Pressed "send again" straight away: told to wait, nothing sent.
    await expect(service.requestCode(INDIA)).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/^A code was sent a moment ago\. Wait \d+ seconds/),
    });
    expect(sms.deliver).toHaveBeenCalledTimes(1);

    advance(60_000);
    await expect(service.requestCode(INDIA)).resolves.toMatchObject({ sent: true });
    expect(sms.deliver).toHaveBeenCalledTimes(2);
  });

  it('sends at most the hourly cap when twenty requests for one number arrive at once', async () => {
    // Cooldown off, so the HOURLY cap is the only thing between twenty requests and twenty texts.
    const { service, sms } = setup({ env: { OTP_SMS_RESEND_COOLDOWN_SECONDS: '0' } });
    const { sent, errors } = await settle(
      Array.from({ length: 20 }, () => service.requestCode(INDIA)),
    );
    expect(sent).toBe(5);
    expect(sms.deliver).toHaveBeenCalledTimes(5);
    expect(errors).toHaveLength(15);
    for (const e of errors) {
      expect(e).toMatchObject({ status: 429, message: expect.stringMatching(/in an hour/) });
    }
  });

  it('with the default cooldown, twenty at once send exactly one', async () => {
    const { service, sms } = setup();
    const { sent } = await settle(Array.from({ length: 20 }, () => service.requestCode(INDIA)));
    expect(sent).toBe(1);
    expect(sms.deliver).toHaveBeenCalledTimes(1);
  });

  it('caps a number per day, across hours', async () => {
    const { service, sms, advance } = setup({ env: { OTP_SMS_RESEND_COOLDOWN_SECONDS: '0' } });
    for (let i = 0; i < 5; i++) await service.requestCode(INDIA);
    await expect(service.requestCode(INDIA)).rejects.toMatchObject({ status: 429 });
    advance(HOUR + MINUTE);
    for (let i = 0; i < 5; i++) await service.requestCode(INDIA);
    advance(HOUR + MINUTE);
    // Ten today. The hour is fresh, the day is not.
    await expect(service.requestCode(INDIA)).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/today\. Try again tomorrow, or sign in with your email/),
    });
    expect(sms.deliver).toHaveBeenCalledTimes(10);

    advance(24 * HOUR);
    await expect(service.requestCode(INDIA)).resolves.toMatchObject({ sent: true });
  });

  it('a limit on one number does not touch another', async () => {
    const { service } = setup();
    await service.requestCode(INDIA);
    await expect(service.requestCode(INDIA)).rejects.toMatchObject({ status: 429 });
    await expect(service.requestCode(indianNumber(1))).resolves.toMatchObject({ sent: true });
  });

  it('asks the store exactly once per request, so there is no gap between check and count', async () => {
    const { service, store } = setup();
    await service.requestCode(INDIA);
    await service.requestCode(INDIA).catch(() => undefined);
    expect(store.calls).toBe(2);
  });
});

describe('sign-in codes: the daily budget (circuit breaker)', () => {
  it('trips on a distributed attack across 500 numbers, and alerts exactly once', async () => {
    const { service, sms, alerts } = setup({
      env: { OTP_SMS_DAILY_LIMIT_TOTAL: '100', OTP_SMS_DAILY_LIMIT_BY_MARKET: '' },
    });
    const { sent, errors } = await settle(
      Array.from({ length: 500 }, (_, i) => service.requestCode(indianNumber(i))),
    );
    expect(sent).toBe(100);
    expect(sms.deliver).toHaveBeenCalledTimes(100);
    expect(errors).toHaveLength(400);
    for (const e of errors) {
      // The answer "text messages are off" already gives: it says nothing about a budget.
      expect(e).toMatchObject({ status: 503, code: 'SMS_UNAVAILABLE' });
      expect(e.message).toMatch(/sign in with your email address/);
      expect(e.message).not.toMatch(/budget|limit/i);
    }

    const tripped = alerts.filter((a) => a.key.startsWith('tripped:'));
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toMatchObject({
      kind: 'OTP_SMS_BUDGET',
      key: 'tripped:total:2026-10-21',
      facts: expect.objectContaining({ dailyLimit: 100, sentToday: 100 }),
    });
    const warned = alerts.filter((a) => a.key.startsWith('warning:'));
    expect(warned).toHaveLength(1);
    expect(warned[0].facts).toMatchObject({ sentToday: 80 });
    // Ids and counts only: no number, masked or not, in any alert.
    expect(JSON.stringify(alerts)).not.toMatch(/\d{8,}|••/);
    // Generous: five hundred requests on a loaded CI runner.
  }, 60_000);

  it('a market budget stops that market only', async () => {
    const { service, alerts } = setup({
      env: { OTP_SMS_DAILY_LIMIT_BY_MARKET: 'US=3,IN=1000' },
    });
    const usNumbers = ['+12125550101', '+13125550102', '+14155550103', '+16175550104'];
    for (const n of usNumbers.slice(0, 3)) await service.requestCode(n);
    await expect(service.requestCode(usNumbers[3])).rejects.toMatchObject({ status: 503 });
    await expect(service.requestCode(INDIA)).resolves.toMatchObject({ sent: true });
    expect(alerts.filter((a) => a.key === 'tripped:US:2026-10-21')).toHaveLength(1);
  });

  it('opens again the next UTC day', async () => {
    const { service, advance } = setup({ env: { OTP_SMS_DAILY_LIMIT_TOTAL: '2' } });
    await service.requestCode(indianNumber(1));
    await service.requestCode(indianNumber(2));
    await expect(service.requestCode(indianNumber(3))).rejects.toMatchObject({ status: 503 });
    advance(24 * HOUR);
    await expect(service.requestCode(indianNumber(3))).resolves.toMatchObject({ sent: true });
  });

  it('a refused request does not spend the budget', async () => {
    const { service, store } = setup({ env: { OTP_SMS_DAILY_LIMIT_TOTAL: '5' } });
    await service.requestCode(INDIA);
    for (let i = 0; i < 10; i++) await service.requestCode(INDIA).catch(() => undefined);
    expect(store.peek('etg:production:otp-sms:budget:2026-10-21:total')).toBe(1);
  });
});

describe('sign-in codes: where a code may go', () => {
  const refused = [
    ['Jamaica (+1 876)', '+18765551234'],
    ['the Dominican Republic (+1 809)', '+18095551234'],
    ['the Dominican Republic (+1 829)', '+18295551234'],
    ['the Cayman Islands (+1 345)', '+13455551234'],
    ['Bermuda (+1 441)', '+14415551234'],
    ['Trinidad (+1 868)', '+18685551234'],
    ['Guam (+1 671)', '+16715551234'],
    ['a premium-rate 900 number', '+19005551234'],
    ['a toll-free 800 number', '+18005551234'],
    ['a toll-free 888 number', '+18885551234'],
    ['an N11 service code as area code', '+14115551234'],
    ['a 976 premium exchange', '+12129761234'],
    ['a personal-communications 500 number', '+15005550006'],
    ['an area code starting with 1', '+11125551234'],
    ['the United Kingdom, not an enabled market', '+447700900123'],
    ['the UAE, not an enabled market', '+971501234567'],
    ['a country this platform does not know', '+8613800138000'],
    ['an Indian landline', '+914023456789'],
  ] as const;

  it.each(refused)('refuses %s before any limit, lookup or send', async (_name, phone) => {
    const { service, sms, prisma, store } = setup();
    await expect(service.requestCode(phone)).rejects.toMatchObject({
      status: 422,
      code: 'SMS_UNDELIVERABLE',
      message:
        "We can't send a text message to this number. Check it, or sign in with your email address.",
    });
    expect(sms.deliver).not.toHaveBeenCalled();
    expect(store.calls).toBe(0);
    expect(prisma.phoneOtp.create).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['India', INDIA, 'IN'],
    ['the United States', US, 'US'],
    ['Toronto', '+14165550123', 'CA'],
    ['Vancouver', '+16045550123', 'CA'],
    ['Puerto Rico (a US jurisdiction on US networks)', '+17875550123', 'US'],
  ])('sends to %s, counted against the right market', async (_name, phone, market) => {
    const { service, metrics } = setup();
    await expect(service.requestCode(phone)).resolves.toMatchObject({ sent: true });
    const text = await metrics.registry.metrics();
    expect(text).toContain(`etg_otp_sms_requests_total{market="${market}",outcome="sent"} 1`);
  });

  it('refuses India when India is not an enabled market', async () => {
    const { service } = setup({ env: { NOTIFICATION_MARKETS: 'US,CA' } });
    await expect(service.requestCode(INDIA)).rejects.toMatchObject({ status: 422 });
  });

  it('allows the United Kingdom once somebody opens it', async () => {
    const { service } = setup({ env: { NOTIFICATION_MARKETS: 'IN,GB' } });
    await expect(service.requestCode('+447700900123')).resolves.toMatchObject({ sent: true });
  });
});

describe('sign-in codes: when Redis is away', () => {
  it('still limits, in Postgres, under the advisory lock', async () => {
    const { service, sms, prisma, advance } = setup({ redisDown: true });
    await expect(service.requestCode(INDIA)).resolves.toMatchObject({ sent: true });
    await expect(service.requestCode(INDIA)).rejects.toMatchObject({ status: 429 });
    advance(60_000);
    await expect(service.requestCode(INDIA)).resolves.toMatchObject({ sent: true });
    expect(sms.deliver).toHaveBeenCalledTimes(2);
    expect(prisma.lockCalls.length).toBeGreaterThan(0);
    expect(String((prisma.lockCalls[0][0] as string[]).join('?'))).toMatch(
      /pg_advisory_xact_lock\(hashtext\(\?\)\)/,
    );
  });

  it('holds the hourly cap against twenty concurrent requests', async () => {
    const { service, sms } = setup({
      redisDown: true,
      env: { OTP_SMS_RESEND_COOLDOWN_SECONDS: '0' },
    });
    const { sent } = await settle(Array.from({ length: 20 }, () => service.requestCode(INDIA)));
    expect(sent).toBe(5);
    expect(sms.deliver).toHaveBeenCalledTimes(5);
  });

  it('holds the total daily budget, and alerts', async () => {
    const { service, alerts } = setup({
      redisDown: true,
      env: { OTP_SMS_DAILY_LIMIT_TOTAL: '10' },
    });
    const { sent } = await settle(
      Array.from({ length: 30 }, (_, i) => service.requestCode(indianNumber(i))),
    );
    expect(sent).toBe(10);
    expect(alerts.some((a) => a.key === 'tripped:total:2026-10-21')).toBe(true);
  });

  it('uses the same fallback when no Redis was ever wired (a hand-built service)', async () => {
    const { service, prisma } = setup({ noStore: true });
    await service.requestCode(INDIA);
    expect(prisma.lockCalls).toHaveLength(1);
  });
});

describe('sign-in codes: what is recorded', () => {
  it('counts each outcome by market, and never the number', async () => {
    const { service, metrics, sms } = setup({ env: { OTP_SMS_DAILY_LIMIT_TOTAL: '2' } });
    await service.requestCode(INDIA);
    await service.requestCode(INDIA).catch(() => undefined); // cooldown
    await service.requestCode('+18765551234').catch(() => undefined); // Jamaica
    sms.deliver.mockRejectedValueOnce(new Error('provider down'));
    await service.requestCode(indianNumber(5)).catch(() => undefined); // provider failed
    await service.requestCode(indianNumber(6)).catch(() => undefined); // budget spent
    const text = await metrics.registry.metrics();
    expect(text).toContain('etg_otp_sms_requests_total{market="IN",outcome="sent"} 1');
    expect(text).toContain('etg_otp_sms_requests_total{market="IN",outcome="rate_limited"} 1');
    expect(text).toContain(
      'etg_otp_sms_requests_total{market="other",outcome="refused_destination"} 1',
    );
    expect(text).toContain('etg_otp_sms_requests_total{market="IN",outcome="provider_failed"} 1');
    expect(text).toContain('etg_otp_sms_requests_total{market="IN",outcome="budget_tripped"} 1');
    expect(text).not.toMatch(/9704464007|8765551234/);
  });

  it('keys Redis by a keyed hash, never by the number', () => {
    const { store } = setup();
    void store;
    const guard = new OtpSmsGuard({ get: () => 'secret' } as never);
    const keys = Object.values(guard.keysFor(INDIA, 'IN')).join(' ');
    expect(keys).not.toMatch(/9704464007|464007/);
    // Keyed: the same number under another secret is a different key.
    const other = new OtpSmsGuard({ get: () => 'another-secret' } as never);
    expect(other.destinationId(INDIA)).not.toBe(guard.destinationId(INDIA));
  });

  it('records the requesting address it was handed', async () => {
    const { service, rows } = setup();
    await service.requestCode(INDIA, '203.0.113.7');
    expect(rows[0].requestedIp).toBe('203.0.113.7');
  });
});
