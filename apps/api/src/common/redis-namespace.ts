/**
 * Environment-scoped Redis keyspace helpers (P6.2 isolation). Every Redis consumer derives its
 * key/prefix from `APP_ENV` so LOCAL / DEV / QA / UAT / STAGING / PRODUCTION can NEVER collide on
 * a shared Redis — the same guarantee the inventory-lock engine already enforces
 * (`InventoryLockKeys`, ADR-039), extended here to BullMQ queues and the read-through cache.
 *
 * The prefix is the ONLY isolation boundary for BullMQ (queue *names* are shared constants like
 * `holds`), so producers (API) and consumers (worker) MUST pass an identical `bullPrefix(APP_ENV)`
 * to every `Queue` / `Worker` / `QueueEvents` — otherwise they silently address different queues.
 */
export function redisEnvRoot(appEnv: string | undefined): string {
  return `etg:${(appEnv ?? 'local').toLowerCase()}`;
}

/** BullMQ `prefix` — namespaces the ENTIRE queue keyspace (jobs, locks, events) per environment. */
export function bullPrefix(appEnv: string | undefined): string {
  return `${redisEnvRoot(appEnv)}:bull`;
}

/** Cache key namespace for the read-through `CacheService`. */
export function cacheKeyPrefix(appEnv: string | undefined): string {
  return `${redisEnvRoot(appEnv)}:cache`;
}

/** Namespace for singleton operational flags (maintenance mode) held in Redis. */
export function opsKeyPrefix(appEnv: string | undefined): string {
  return `${redisEnvRoot(appEnv)}:ops`;
}

/**
 * BullMQ connection options parsed from a `REDIS_URL`.
 *
 * BullMQ needs a plain options object rather than a shared `ioredis` instance (passing an
 * instance makes BullMQ take ownership of its lifecycle, and our `ioredis` version can differ
 * from the one bundled inside bullmq). Building that object by hand previously kept only
 * `host` + `port`, which silently DROPPED the credentials, database index, and TLS scheme that
 * every managed Redis (Railway, ElastiCache, Upstash…) puts in the URL — the queues then fail
 * with `NOAUTH` at runtime while the API's own `RedisService` (which passes the URL straight to
 * ioredis) connects fine. Parse the whole URL so managed Redis works everywhere.
 */
export interface BullConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  /** Required by BullMQ workers: blocking commands must not be retry-capped. */
  maxRetriesPerRequest: null;
}

export function bullConnectionFromUrl(redisUrl: string): BullConnectionOptions {
  const url = new URL(redisUrl);
  const secure = url.protocol === 'rediss:';
  const options: BullConnectionOptions = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    maxRetriesPerRequest: null,
  };
  // `redis://:password@host` (no user) is valid and common; only send a username when present
  // so Redis servers without ACL users are not handed an empty AUTH username.
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  // `redis://host:6379/3` selects logical database 3.
  const dbPath = url.pathname.replace(/^\//, '');
  if (dbPath) {
    const db = Number(dbPath);
    if (Number.isInteger(db) && db >= 0) options.db = db;
  }
  // ioredis enables TLS when `tls` is present at all; an empty object keeps the platform's
  // default verification (do NOT disable certificate checking here).
  if (secure) options.tls = {};
  return options;
}
