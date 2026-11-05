import IORedis, { type Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { RedisService } from '../redis/redis.service';
import { OtpSmsGuard, type OtpReservation } from './otp-sms-guard';
import { MemoryOtpSmsCounterStore } from './test-support/otp-sms-memory-store';

/**
 * integration - the sign-in code limiter's Lua script against REAL Redis.
 *
 * The unit specs run an in-memory port of the script. These run the script itself - the only
 * place its atomicity is real - and hold it to the port, decision for decision, so the two
 * cannot drift. Each run uses its own APP_ENV namespace, so nothing collides with anything.
 *
 * Connects to REDIS_URL (CI provides one) and SKIPS GRACEFULLY when Redis is absent.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
let client: Redis;
let available = false;

beforeAll(async () => {
  client = new IORedis(URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await client.connect();
    available = (await client.ping()) === 'PONG';
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (client) await client.quit().catch(() => undefined);
});

const T0 = Date.parse('2026-10-21T08:00:00.000Z');

function guards(env: Record<string, string> = {}) {
  const appEnv = `jest-otp-${randomUUID()}`;
  const values: Record<string, string> = { APP_ENV: appEnv, JWT_ACCESS_SECRET: 'it', ...env };
  const config = { get: (k: string) => values[k] };
  const alerts: string[] = [];
  const opsAlerts = {
    notify: async (a: { key: string }) => {
      alerts.push(a.key);
      return { raised: true, count: 1, delivered: 0 };
    },
  };
  // The REAL clock: Redis keeps its own time, so the script's TTLs are real milliseconds.
  const real = new OtpSmsGuard(
    config as never,
    { client } as unknown as RedisService,
    opsAlerts as never,
  );
  const memory = new OtpSmsGuard(
    config as never,
    undefined,
    undefined,
    new MemoryOtpSmsCounterStore(() => T0),
    () => T0,
  );
  return { real, memory, alerts, appEnv };
}

const indian = (i: number) => `+9198${String(10_000_000 + i).slice(-8)}`;

describe('OtpSmsGuard on real Redis', () => {
  afterEach(async () => {
    if (!available) return;
    const keys = await client.keys('etg:jest-otp-*');
    if (keys.length) await client.del(...keys);
  });

  it('lets exactly the hourly cap through when twenty requests race for one number', async () => {
    if (!available) return;
    const { real } = guards({ OTP_SMS_RESEND_COOLDOWN_SECONDS: '0' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => real.reserve('+919704464007', 'IN')),
    );
    expect(results.filter((r) => r.status === 'allowed')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'refused')).toHaveLength(15);
  });

  it('enforces the cooldown and reports how long is left', async () => {
    if (!available) return;
    const { real } = guards();
    expect(await real.reserve('+919704464007', 'IN')).toEqual({ status: 'allowed' });
    const second = await real.reserve('+919704464007', 'IN');
    expect(second).toMatchObject({ status: 'refused', refusal: 'cooldown' });
    expect((second as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(55);
    expect((second as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('trips the total budget under a 500-number race, and flags the trip exactly once', async () => {
    if (!available) return;
    const { real, alerts } = guards({
      OTP_SMS_DAILY_LIMIT_TOTAL: '100',
      OTP_SMS_DAILY_LIMIT_BY_MARKET: '',
    });
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) => real.reserve(indian(i), 'IN')),
    );
    expect(results.filter((r) => r.status === 'allowed')).toHaveLength(100);
    expect(
      results.filter((r) => r.status === 'refused' && r.refusal === 'budget_total'),
    ).toHaveLength(400);
    await new Promise((r) => setImmediate(r));
    expect(alerts.filter((k) => k.startsWith('tripped:total:'))).toHaveLength(1);
    expect(alerts.filter((k) => k.startsWith('warning:total:'))).toHaveLength(1);
  });

  it('gives every key it writes an expiry, and stores no phone number', async () => {
    if (!available) return;
    const { real, appEnv } = guards();
    await real.reserve('+919704464007', 'IN');
    const keys = await client.keys(`etg:${appEnv}:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/9704464007|464007/);
      expect(await client.pttl(key)).toBeGreaterThan(0);
    }
  });

  it('decides exactly as the in-memory port does, request for request', async () => {
    if (!available) return;
    const { real, memory } = guards({
      OTP_SMS_RESEND_COOLDOWN_SECONDS: '0',
      OTP_SMS_DAILY_LIMIT_TOTAL: '12',
      OTP_SMS_DAILY_LIMIT_BY_MARKET: 'US=4',
    });
    const sequence: Array<[string, string]> = [];
    for (let i = 0; i < 7; i++) sequence.push(['+919704464007', 'IN']); // hourly cap at 5
    for (let i = 0; i < 6; i++) sequence.push([`+1415555010${i}`, 'US']); // US budget at 4
    for (let i = 0; i < 6; i++) sequence.push([indian(i), 'IN']); // total at 12
    const strip = (r: OtpReservation) =>
      r.status === 'refused' ? { status: r.status, refusal: r.refusal } : { status: r.status };
    for (const [phone, market] of sequence) {
      expect(strip(await real.reserve(phone, market))).toEqual(
        strip(await memory.reserve(phone, market)),
      );
    }
  });
});
