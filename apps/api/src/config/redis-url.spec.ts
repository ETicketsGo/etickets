import { resolveRedisUrl } from './redis-url';

/**
 * A deployed process must not quietly fall back to a Redis on localhost.
 *
 * The default exists for developer machines. In a container there is nothing on localhost, and
 * because the Redis consumers fail open, a service that lost REDIS_URL booted healthy and then
 * failed every cache, maintenance and queue operation without ever crashing.
 */
describe('resolveRedisUrl', () => {
  it.each(['QA', 'UAT', 'STAGING', 'PRODUCTION'])(
    'refuses to start %s with no REDIS_URL',
    (env) => {
      expect(() => resolveRedisUrl(undefined, env)).toThrow(/REDIS_URL is not set/);
      expect(() => resolveRedisUrl('   ', env)).toThrow(/REDIS_URL is not set/);
    },
  );

  it.each([
    'redis://localhost:6379',
    'redis://127.0.0.1:6379',
    'rediss://default:secret@localhost:6380/0',
    'redis://[::1]:6379',
    'redis://0.0.0.0:6379',
  ])('refuses the local default %s outside local development', (url) => {
    expect(() => resolveRedisUrl(url, 'QA')).toThrow(/points at/);
  });

  it('keys on APP_ENV, so a QA process running NODE_ENV=production is still refused', () => {
    // The config schema's own default is what an unset variable resolves to.
    expect(() => resolveRedisUrl('redis://localhost:6379', 'qa')).toThrow(/APP_ENV=QA/);
  });

  it('never echoes the URL, which carries the password', () => {
    expect(() => resolveRedisUrl('not a url with hunter2', 'UAT')).toThrow(/not a valid URL/);
    try {
      resolveRedisUrl('redis://default:hunter2@localhost:6379', 'UAT');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });

  it('accepts an environment’s own Redis', () => {
    const url = 'redis://default:pw@redis.railway.internal:6379';
    expect(resolveRedisUrl(url, 'PRODUCTION')).toBe(url);
  });

  it.each(['LOCAL', 'DEV', 'TEST', undefined, ''])(
    'keeps the localhost default for local development (APP_ENV=%s)',
    (env) => {
      expect(resolveRedisUrl(undefined, env)).toBe('redis://localhost:6379');
      expect(resolveRedisUrl('redis://127.0.0.1:6380', env)).toBe('redis://127.0.0.1:6380');
    },
  );
});
