import IORedis, { type Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import type { RedisService } from '../redis/redis.service';

/**
 * integration - the rate-limit script against REAL Redis.
 *
 * The unit spec mocks `eval`, so the Lua never ran in a test - which is how a units defect got
 * through: `@nestjs/throttler` passes MILLISECONDS and the script treated them as seconds, so
 * a one-minute window (and every block) lasted 16.7 hours. These run the script itself and
 * hold it to the library's own in-memory storage, record for record.
 *
 * Connects to REDIS_URL and SKIPS GRACEFULLY (each test returns early) when Redis is absent.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
let client: Redis;
let available = false;
let storage: RedisThrottlerStorage;

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
  const redis = { client } as unknown as RedisService;
  const config = { get: (k: string) => (k === 'APP_ENV' ? 'jesttest' : undefined) };
  storage = new RedisThrottlerStorage(redis, config as never);
});

afterAll(async () => {
  if (client) await client.quit().catch(() => undefined);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MINUTE_MS = 60_000;

describe('RedisThrottlerStorage (real Redis)', () => {
  it('keeps a one-minute window to one minute - milliseconds in, seconds out', async () => {
    if (!available) return;
    const key = `ip:${randomUUID()}`;
    const r = await storage.increment(key, MINUTE_MS, 10, MINUTE_MS, 'default');
    expect(r).toEqual({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    // What Redis actually holds: at most a minute, not 60,000 seconds.
    const pttl = await client.pttl(`${await keyFor(key)}`);
    expect(pttl).toBeGreaterThan(55_000);
    expect(pttl).toBeLessThanOrEqual(MINUTE_MS);
  });

  it('blocks past the limit for blockDuration, and a blocked caller cannot extend it', async () => {
    if (!available) return;
    const key = `ip:${randomUUID()}`;
    for (let i = 0; i < 2; i++) await storage.increment(key, MINUTE_MS, 2, 30_000, 'default');
    const third = await storage.increment(key, MINUTE_MS, 2, 30_000, 'default');
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true, timeToBlockExpire: 30 });
    const blockKey = `${await keyFor(key)}:blocked`;
    const before = await client.pttl(blockKey);
    expect(before).toBeLessThanOrEqual(30_000);
    expect(before).toBeGreaterThan(25_000);
    await sleep(50);
    const fourth = await storage.increment(key, MINUTE_MS, 2, 30_000, 'default');
    expect(fourth.isBlocked).toBe(true);
    expect(await client.pttl(blockKey)).toBeLessThan(before);
  });

  it('resets when the window ends, so nobody is locked out for good', async () => {
    if (!available) return;
    const key = `ip:${randomUUID()}`;
    await storage.increment(key, 300, 10, 300, 'default');
    await storage.increment(key, 300, 10, 300, 'default');
    await sleep(450);
    const after = await storage.increment(key, 300, 10, 300, 'default');
    expect(after.totalHits).toBe(1);
  });

  it('reports the same record as the library in-memory storage for the same hits', async () => {
    /*
      The guard cannot tell the two storages apart, so neither may the records. The auth
      limit's own shape: 10 a minute, blocked for the window.
    */
    if (!available) return;
    const memory = new ThrottlerStorageService();
    const key = `ip:${randomUUID()}`;
    for (let i = 0; i < 12; i++) {
      const fromRedis = await storage.increment(key, MINUTE_MS, 10, MINUTE_MS, 'auth');
      const fromMemory = await memory.increment(key, MINUTE_MS, 10, MINUTE_MS, 'auth');
      // The library leaves timeToBlockExpire meaningless (negative) while not blocked; the guard
      // reads it only once a caller IS blocked, so that is where it must agree.
      const { timeToBlockExpire: redisBlock, ...redisRest } = fromRedis;
      const { timeToBlockExpire: memoryBlock, ...memoryRest } = fromMemory;
      expect(redisRest).toEqual(memoryRest);
      if (fromMemory.isBlocked) expect(redisBlock).toBe(memoryBlock);
    }
    memory.onApplicationShutdown();
  });
});

/** The counter key the storage writes, read back from Redis rather than re-derived. */
async function keyFor(key: string): Promise<string> {
  const [found] = await client.keys(`*:default:${key}`);
  return found;
}
