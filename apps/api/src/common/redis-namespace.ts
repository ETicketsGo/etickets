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
