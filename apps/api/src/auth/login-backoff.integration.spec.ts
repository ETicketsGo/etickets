import IORedis, { type Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { LoginBackoff, backoffSubject } from './login-backoff';
import type { RedisService } from '../redis/redis.service';

/**
 * integration - the backoff's Lua script against REAL Redis.
 *
 * The unit spec covers the in-process path; this runs the script itself, because a script that
 * only ever ran against a mock is how the throttler once shipped a one-minute window that lasted
 * 16.7 hours (see common/redis-throttler.storage.integration.spec.ts).
 *
 * Connects to REDIS_URL and SKIPS GRACEFULLY (each test returns early) when Redis is absent.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
let client: Redis;
let available = false;
let backoff: LoginBackoff;
const PREFIX = 'etg:jesttest:login-backoff:';

// Dozens of sequential round trips per test; a loaded CI box (or Docker on Windows) is slow.
jest.setTimeout(30_000);

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
  const config = { get: (k: string) => (k === 'APP_ENV' ? 'jesttest' : undefined) };
  backoff = new LoginBackoff({ client } as unknown as RedisService, config as never);
});

afterAll(async () => {
  if (client) await client.quit().catch(() => undefined);
});

const address = () => `${randomUUID()}@example.com`;

describe('LoginBackoff (real Redis)', () => {
  it('waits 30 s at the fifth failure, 60 s at the sixth, and no longer than 15 minutes', async () => {
    if (!available) return;
    const email = address();
    for (let i = 0; i < 4; i++) expect(await backoff.recordFailure(email)).toBe(0);
    expect(await backoff.waitFor(email)).toBe(0);
    expect(await backoff.recordFailure(email)).toBe(30_000);
    const wait = await backoff.waitFor(email);
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);
    expect(await backoff.recordFailure(email)).toBe(60_000);
    for (let i = 0; i < 20; i++) await backoff.recordFailure(email);
    expect(await backoff.waitFor(email)).toBeLessThanOrEqual(15 * 60_000);
  });

  it('every key it writes expires: nothing it does can lock an account for good', async () => {
    if (!available) return;
    const email = address();
    for (let i = 0; i < 8; i++) await backoff.recordFailure(email);
    const subject = backoffSubject(email);
    const counterTtl = await client.pttl(`${PREFIX}${subject}:n`);
    const waitTtl = await client.pttl(`${PREFIX}${subject}:wait`);
    expect(counterTtl).toBeGreaterThan(0);
    expect(waitTtl).toBeGreaterThan(0);
    // The count outlives the wait, so the next failure after a wait still doubles it.
    expect(counterTtl).toBeGreaterThan(waitTtl);
  });

  it('is per address, and a reset clears it', async () => {
    if (!available) return;
    const a = address();
    const b = address();
    for (let i = 0; i < 5; i++) await backoff.recordFailure(a);
    expect(await backoff.waitFor(a)).toBeGreaterThan(0);
    expect(await backoff.waitFor(b)).toBe(0);
    await backoff.reset(a);
    expect(await backoff.waitFor(a)).toBe(0);
    expect(await client.exists(`${PREFIX}${backoffSubject(a)}:n`)).toBe(0);
  });

  it('is shared: a second instance (another replica) sees the same wait', async () => {
    if (!available) return;
    const email = address();
    for (let i = 0; i < 5; i++) await backoff.recordFailure(email);
    const config = { get: (k: string) => (k === 'APP_ENV' ? 'jesttest' : undefined) };
    const replica = new LoginBackoff({ client } as unknown as RedisService, config as never);
    expect(await replica.waitFor(email)).toBeGreaterThan(0);
  });
});
