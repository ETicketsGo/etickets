/**
 * The Redis URL this process may use, or a refusal to start.
 *
 * ── WHY LOCALHOST IS REFUSED OUTSIDE LOCAL DEVELOPMENT ─────────────────────────────
 * `REDIS_URL` defaults to `redis://localhost:6379`, which is right on a developer's machine and
 * silently wrong everywhere else. A deployed container has no Redis on localhost, so a service
 * that lost the variable booted "healthy" and then failed every cache read, maintenance check
 * and queue operation one at a time — and the RedisService consumers are deliberately fail-open,
 * so nothing crashed loudly enough to be noticed. A worker in that state would never expire a
 * hold or send a notification.
 *
 * Keyed on APP_ENV, not NODE_ENV: QA and UAT run with NODE_ENV=production, and APP_ENV is what
 * says whether this is somebody's laptop. An unset APP_ENV is LOCAL, matching the config
 * schema's own default.
 */

/** Environments where a Redis on localhost is the expected thing. */
const LOCAL_ENVIRONMENTS = ['LOCAL', 'DEV', 'TEST'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const DEFAULT_LOCAL_URL = 'redis://localhost:6379';

export function resolveRedisUrl(url: string | undefined, appEnv: string | undefined): string {
  const env = (appEnv ?? '').trim().toUpperCase() || 'LOCAL';
  const value = (url ?? '').trim();
  if (LOCAL_ENVIRONMENTS.includes(env)) return value || DEFAULT_LOCAL_URL;

  if (!value) {
    throw new Error(
      `REDIS_URL is not set, and APP_ENV=${env} has no Redis on localhost. ` +
        'Set REDIS_URL to this environment’s own Redis (on Railway, a reference to its Redis service).',
    );
  }
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    // The value is not echoed: a Redis URL carries its password.
    throw new Error(`REDIS_URL is not a valid URL (APP_ENV=${env}).`);
  }
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || host.startsWith('127.')) {
    throw new Error(
      `REDIS_URL points at ${host}, and APP_ENV=${env} has no Redis there. ` +
        'This is the local-development default; set REDIS_URL to this environment’s own Redis.',
    );
  }
  return value;
}
