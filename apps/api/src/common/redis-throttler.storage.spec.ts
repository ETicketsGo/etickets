import { RedisThrottlerStorage, throttlerStorageMode } from './redis-throttler.storage';
import { throttleKeyPrefix } from './redis-namespace';

/**
 * unit - rate-limit counters that survive a restart, and the default each environment gets.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────
 * The credential limit lived in one process, so it was lost on every restart and multiplied by
 * the replica count. This moves it to Redis - which is already provisioned, with a client
 * already in the dependency tree.
 *
 * The tests weighted hardest are the DEFAULT (deployed environments set nothing, so the
 * default IS production) and the DEGRADED path, because a security control whose failure mode has never
 * been exercised is a guess.
 */

function makeStorage(evalImpl: (...a: unknown[]) => Promise<unknown>) {
  const client = { eval: jest.fn(evalImpl) };
  const config = { get: (k: string) => (k === 'APP_ENV' ? 'PRODUCTION' : undefined) };
  const storage = new RedisThrottlerStorage({ client } as never, config as never);
  return { storage, client };
}

/** A config with THROTTLE_STORAGE = `storage` and APP_ENV = `env`. */
function cfg(storage: string | undefined, env: string | undefined) {
  return {
    get: <T>(k: string) =>
      (k === 'THROTTLE_STORAGE' ? storage : k === 'APP_ENV' ? env : undefined) as T | undefined,
  };
}

describe('the default follows the environment', () => {
  it('is redis in every deployed environment when nothing is configured', () => {
    // Deployed environments set no THROTTLE_STORAGE, so this is what they run.
    for (const env of ['QA', 'UAT', 'STAGING', 'PRODUCTION', 'production']) {
      expect(throttlerStorageMode(cfg(undefined, env))).toBe('redis');
    }
  });

  it('is memory on a developer machine or in a test run, which has no Redis to rely on', () => {
    for (const env of ['LOCAL', 'DEV', 'TEST', undefined, '']) {
      expect(throttlerStorageMode(cfg(undefined, env))).toBe('memory');
    }
  });

  it('obeys an explicit choice in either direction, case-insensitively', () => {
    expect(throttlerStorageMode(cfg(' Memory ', 'PRODUCTION'))).toBe('memory');
    expect(throttlerStorageMode(cfg('redis', 'LOCAL'))).toBe('redis');
    expect(throttlerStorageMode(cfg(' Redis ', 'LOCAL'))).toBe('redis');
  });

  it('reads anything unrecognised as the environment default, not as something nobody chose', () => {
    for (const raw of ['', '  ', 'REDISS', 'yes', 'true', 'memcached']) {
      expect(throttlerStorageMode(cfg(raw, 'PRODUCTION'))).toBe('redis');
      expect(throttlerStorageMode(cfg(raw, 'LOCAL'))).toBe('memory');
    }
  });
});

describe('counting a hit', () => {
  it('returns what the script reports, in the record shape the guard expects', async () => {
    const { storage } = makeStorage(async () => [3, 42, 0, 0]);
    await expect(storage.increment('ip:1.2.3.4', 60, 10, 0, 'default')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('reports a block as blocked', async () => {
    const { storage } = makeStorage(async () => [11, 30, 1, 30]);
    const r = await storage.increment('ip:1.2.3.4', 60, 10, 30, 'default');
    expect(r.isBlocked).toBe(true);
    expect(r.timeToBlockExpire).toBe(30);
  });

  it('namespaces the key per environment, so QA cannot spend production budget', async () => {
    const { storage, client } = makeStorage(async () => [1, 60, 0, 0]);
    await storage.increment('ip:1.2.3.4', 60, 10, 0, 'default');
    const [, , hitKey, blockKey] = client.eval.mock.calls[0] as unknown[];
    expect(hitKey).toBe(`${throttleKeyPrefix('PRODUCTION')}:default:ip:1.2.3.4`);
    expect(blockKey).toBe(`${throttleKeyPrefix('PRODUCTION')}:default:ip:1.2.3.4:blocked`);
    // Two different environments must not collide.
    expect(throttleKeyPrefix('QA')).not.toBe(throttleKeyPrefix('PRODUCTION'));
  });

  it('separates the counter from the block marker', async () => {
    /*
      Two keys on purpose. A blocked caller that keeps hammering must not be able to extend
      its own penalty, which it could if the block shared the counter's expiry.
    */
    const { storage, client } = makeStorage(async () => [1, 60, 0, 0]);
    await storage.increment('k', 60, 10, 30, 'default');
    expect(client.eval.mock.calls[0][1]).toBe(2);
  });
});

describe('when Redis is unreachable', () => {
  it('still enforces a limit, from per-process memory', async () => {
    /*
      THE DEGRADED PATH. Failing closed would make Redis an availability dependency for every
      login - a blip during an on-sale locks out every customer, turning a cache outage into
      an authentication outage. Failing open hands an attacker the mechanism. So it counts in
      memory: weaker, but a real limit.
    */
    const { storage } = makeStorage(async () => {
      throw new Error('ECONNREFUSED');
    });
    const first = await storage.increment('ip:9.9.9.9', 60, 2, 0, 'default');
    const second = await storage.increment('ip:9.9.9.9', 60, 2, 0, 'default');
    expect(first.totalHits).toBe(1);
    // Counting continues rather than resetting or being abandoned.
    expect(second.totalHits).toBe(2);
  });

  it('does not throw the request away', async () => {
    const { storage } = makeStorage(async () => {
      throw new Error('READONLY You cannot write against a read only replica');
    });
    await expect(storage.increment('k', 60, 10, 0, 'default')).resolves.toBeDefined();
  });

  it('says so once, not once per request', async () => {
    const { storage } = makeStorage(async () => {
      throw new Error('ECONNREFUSED');
    });
    const logger = (storage as unknown as { logger: { warn: (m: string) => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) await storage.increment('k', 60, 10, 0, 'default');
    // An outage must not also flood the log it would be diagnosed from.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('per-process memory');
  });
});
