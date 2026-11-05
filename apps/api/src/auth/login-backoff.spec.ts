import { LoginBackoff, backoffSubject, delayAfter, LOGIN_BACKOFF_DEFAULTS } from './login-backoff';
import type { RedisService } from '../redis/redis.service';

/**
 * unit - the per-account backoff's arithmetic and its in-process path.
 *
 * The Redis script is held to the same rules against a real Redis in
 * login-backoff.integration.spec.ts; this file covers what happens with no Redis at all (a
 * harness) and with a Redis that has gone away (the fallback the running API relies on).
 */
describe('LoginBackoff', () => {
  const MIN = 60_000;

  function memoryBackoff() {
    const b = new LoginBackoff();
    let t = 1_000_000;
    b.now = () => t;
    return { b, advance: (ms: number) => (t += ms) };
  }

  it('lets the first four wrong passwords through and makes the fifth wait 30 seconds', async () => {
    const { b } = memoryBackoff();
    for (let i = 1; i <= 4; i++) {
      expect(await b.recordFailure('asha@example.com')).toBe(0);
      expect(await b.waitFor('asha@example.com')).toBe(0);
    }
    expect(await b.recordFailure('asha@example.com')).toBe(30_000);
    expect(await b.waitFor('asha@example.com')).toBe(30_000);
  });

  it('doubles the wait per further failure and never waits longer than the cap', () => {
    const s = LOGIN_BACKOFF_DEFAULTS;
    expect([5, 6, 7, 8, 9, 10, 11, 50].map((n) => delayAfter(n, s))).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      480_000,
      15 * MIN,
      15 * MIN,
      15 * MIN,
    ]);
  });

  it('is never a permanent lock: the wait runs out on its own', async () => {
    const { b, advance } = memoryBackoff();
    for (let i = 0; i < 20; i++) await b.recordFailure('asha@example.com');
    expect(await b.waitFor('asha@example.com')).toBe(15 * MIN);
    advance(15 * MIN);
    expect(await b.waitFor('asha@example.com')).toBe(0);
  });

  it('counts per address: one account waiting does not touch another', async () => {
    const { b } = memoryBackoff();
    for (let i = 0; i < 5; i++) await b.recordFailure('asha@example.com');
    expect(await b.waitFor('asha@example.com')).toBeGreaterThan(0);
    expect(await b.waitFor('ravi@example.com')).toBe(0);
  });

  it('treats one address however it is typed as one address', async () => {
    const { b } = memoryBackoff();
    for (let i = 0; i < 5; i++)
      await b.recordFailure(i % 2 ? ' Asha@Example.COM ' : 'asha@example.com');
    expect(await b.waitFor('ASHA@example.com')).toBeGreaterThan(0);
    expect(backoffSubject(' A@B.C ')).toBe(backoffSubject('a@b.c'));
    // Hashed, so the keyspace is not a list of addresses.
    expect(backoffSubject('a@b.c')).not.toContain('@');
  });

  it('forgets old failures once the window has passed', async () => {
    const { b, advance } = memoryBackoff();
    for (let i = 0; i < 4; i++) await b.recordFailure('asha@example.com');
    advance(15 * MIN + 1);
    expect(await b.recordFailure('asha@example.com')).toBe(0);
  });

  it('a reset starts the count again', async () => {
    const { b } = memoryBackoff();
    for (let i = 0; i < 6; i++) await b.recordFailure('asha@example.com');
    await b.reset('asha@example.com');
    expect(await b.waitFor('asha@example.com')).toBe(0);
    expect(await b.recordFailure('asha@example.com')).toBe(0);
  });

  it('keeps counting in this process when Redis is unreachable, rather than failing open', async () => {
    const down = new Error('Connection is closed.');
    const redis = {
      client: {
        pttl: jest.fn().mockRejectedValue(down),
        eval: jest.fn().mockRejectedValue(down),
        del: jest.fn().mockRejectedValue(down),
      },
    } as unknown as RedisService;
    const b = new LoginBackoff(redis);
    for (let i = 0; i < 5; i++) await b.recordFailure('asha@example.com');
    expect(await b.waitFor('asha@example.com')).toBeGreaterThan(0);
    expect(await b.waitFor('ravi@example.com')).toBe(0);
    // And it does not take sign-in down with it: reset still resolves.
    await expect(b.reset('asha@example.com')).resolves.toBeUndefined();
  });

  it('reads its limits from configuration', async () => {
    const values: Record<string, string> = {
      LOGIN_BACKOFF_THRESHOLD: '2',
      LOGIN_BACKOFF_BASE_SECONDS: '10',
      LOGIN_BACKOFF_MAX_MINUTES: '1',
    };
    const b = new LoginBackoff(undefined, { get: (k: string) => values[k] } as never);
    expect(await b.recordFailure('x@example.com')).toBe(0);
    expect(await b.recordFailure('x@example.com')).toBe(10_000);
    for (let i = 0; i < 10; i++) await b.recordFailure('x@example.com');
    expect(await b.waitFor('x@example.com')).toBeLessThanOrEqual(MIN);
  });
});
