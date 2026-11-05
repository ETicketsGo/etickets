import {
  OTP_SMS_RESERVE_SCRIPT,
  OtpSmsGuard,
  RedisOtpSmsCounterStore,
  otpSmsLimits,
  parseMarketLimits,
} from './otp-sms-guard';
import type { RedisService } from '../redis/redis.service';

/**
 * unit - the contract of the Redis script and of the call that runs it.
 *
 * The in-memory store used by `otp-sms-abuse.spec.ts` is a port of this script; these pin the
 * properties of the script ITSELF that the port relies on, so a change to one that is not made
 * to the other is caught here. `otp-sms-guard.integration.spec.ts` runs it on a real Redis.
 */
describe('OTP_SMS_RESERVE_SCRIPT', () => {
  const script = OTP_SMS_RESERVE_SCRIPT;
  const at = (needle: string) => {
    const i = script.indexOf(needle);
    if (i < 0) throw new Error(`script no longer contains: ${needle}`);
    return i;
  };

  it('reads nine keys and eight arguments, no more', () => {
    const keys = new Set(script.match(/KEYS\[(\d+)\]/g));
    const argv = new Set(script.match(/ARGV\[(\d+)\]/g));
    expect([...keys].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `KEYS[${n}]`).sort());
    expect([...argv].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `ARGV[${n}]`).sort());
  });

  it('checks every limit BEFORE it increments anything', () => {
    const firstIncrement = at("redis.call('INCR'");
    const lastCheck = at('marketLimit > 0 and market >= marketLimit');
    // `bump` is defined above the checks but only CALLED after them.
    const firstBumpCall = at('bump(KEYS[2], HOUR_MS)');
    expect(lastCheck).toBeLessThan(firstBumpCall);
    expect(firstIncrement).toBeLessThan(firstBumpCall); // the definition, not a call
  });

  it('checks the day, then the hour, then the cooldown, then the budget', () => {
    const order = [
      'count(KEYS[3]) >= dayLimit',
      'count(KEYS[2]) >= hourLimit',
      "redis.call('PTTL', KEYS[1])",
      'total >= totalLimit',
      'market >= marketLimit',
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('gives every counter an expiry in the same script that creates it', () => {
    expect(script).toMatch(
      /if n == 1 or redis\.call\('PTTL', key\) < 0 then\s+redis\.call\('PEXPIRE', key, windowMs\)/,
    );
  });

  it('marks a trip and a warning with SET NX, so each is reported once', () => {
    for (const k of [6, 7, 8, 9]) {
      expect(script).toContain(`redis.call('SET', KEYS[${k}], '1', 'PX', budgetTtlMs, 'NX')`);
    }
  });

  it('never runs a command that scans or deletes the keyspace', () => {
    expect(script).not.toMatch(/'(KEYS|SCAN|DEL|FLUSHDB|FLUSHALL|EXPIRE)'/);
  });
});

describe('RedisOtpSmsCounterStore', () => {
  it('runs the script in ONE eval with nine keys, none of them carrying the number', async () => {
    const evalCalls: unknown[][] = [];
    const redis = {
      client: {
        eval: jest.fn(async (...args: unknown[]) => {
          evalCalls.push(args);
          return [0, 0, 0, 1, 1];
        }),
        get: jest.fn(),
        incr: jest.fn(),
        set: jest.fn(),
      },
    } as unknown as RedisService;
    const config = { get: (k: string) => ({ APP_ENV: 'QA', JWT_ACCESS_SECRET: 's' })[k] };
    const guard = new OtpSmsGuard(config as never, redis);
    await expect(guard.reserve('+919704464007', 'IN')).resolves.toEqual({ status: 'allowed' });

    expect(evalCalls).toHaveLength(1);
    const [script, numKeys, ...rest] = evalCalls[0];
    expect(script).toBe(OTP_SMS_RESERVE_SCRIPT);
    expect(numKeys).toBe(9);
    const keys = rest.slice(0, 9) as string[];
    for (const key of keys) {
      expect(key.startsWith('etg:qa:otp-sms:')).toBe(true);
      expect(key).not.toMatch(/9704464007|464007/);
    }
    // cooldown, hour cap, day cap, total, market (IN default 1500), warn at 80% of each, ttl.
    expect(rest.slice(9)).toEqual([
      '60000',
      '5',
      '10',
      '2000',
      '1500',
      '1600',
      '1200',
      '172800000',
    ]);
    // Nothing else touched Redis: no read-then-write.
    const client = (redis as unknown as { client: Record<string, jest.Mock> }).client;
    expect(client.get).not.toHaveBeenCalled();
    expect(client.incr).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('answers store_unavailable, never "allowed", when Redis rejects', async () => {
    const redis = {
      client: { eval: jest.fn().mockRejectedValue(new Error('Connection is closed.')) },
    } as unknown as RedisService;
    const guard = new OtpSmsGuard({ get: () => undefined } as never, redis);
    await expect(guard.reserve('+919704464007', 'IN')).resolves.toEqual({
      status: 'store_unavailable',
    });
  });

  it('treats an answer it does not recognise as store_unavailable, not as permission', async () => {
    const store = { reserve: jest.fn().mockResolvedValue([9, 0, 0, 0, 0]) };
    const guard = new OtpSmsGuard({ get: () => undefined } as never, undefined, undefined, store);
    await expect(guard.reserve('+919704464007', 'IN')).resolves.toEqual({
      status: 'store_unavailable',
    });
  });

  it('is constructible over the API Redis client', () => {
    expect(new RedisOtpSmsCounterStore({ client: {} } as never)).toBeInstanceOf(
      RedisOtpSmsCounterStore,
    );
  });
});

describe('otpSmsLimits', () => {
  it('uses the defaults when nothing is set', () => {
    expect(otpSmsLimits({ get: () => undefined })).toEqual({
      cooldownSeconds: 60,
      perNumberPerHour: 5,
      perNumberPerDay: 10,
      dailyTotal: 2000,
      dailyByMarket: { IN: 1500, US: 500, CA: 250 },
      warnPercent: 80,
    });
  });

  it('reads configured values, numbers or strings', () => {
    const env: Record<string, unknown> = {
      OTP_SMS_RESEND_COOLDOWN_SECONDS: 30,
      OTP_SMS_MAX_PER_NUMBER_PER_HOUR: '3',
      OTP_SMS_DAILY_LIMIT_BY_MARKET: 'in=10,US=2',
    };
    const limits = otpSmsLimits({ get: <T>(k: string) => env[k] as T });
    expect(limits).toMatchObject({
      cooldownSeconds: 30,
      perNumberPerHour: 3,
      dailyByMarket: { IN: 10, US: 2 },
    });
  });

  it('parses a market table and drops what it cannot read', () => {
    expect(parseMarketLimits('IN=1500, US=500 ,CA=x,=4,GB')).toEqual({ IN: 1500, US: 500 });
  });
});
