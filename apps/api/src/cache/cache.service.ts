import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { cacheKeyPrefix } from '../common/redis-namespace';

/**
 * Tiny read-through cache over Redis for anonymous, identical-for-everyone read
 * paths (discovery + public catalog). Deliberately minimal and fail-open:
 *
 *  - Hit  → returns the parsed JSON value (no producer call).
 *  - Miss → runs the producer, stores the result with a TTL, returns it.
 *  - Any Redis error (read or write) is logged and the producer is used as the
 *    source of truth, so the cache can NEVER fail a request.
 *
 * Values are round-tripped through JSON, exactly as they are for the HTTP
 * response, so a cached response is byte-for-byte equal to an uncached one on
 * the wire. Only use for data that is safe to serve slightly stale (short TTL)
 * and is NOT user-specific.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  /** Env-scoped key prefix (P6.2) so LOCAL/…/PRODUCTION never share cache entries on one Redis. */
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.prefix = cacheKeyPrefix(config.get<string>('APP_ENV'));
  }

  /** Namespace a caller-supplied key with the environment prefix. */
  private ns(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async getOrSet<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const nsKey = this.ns(key);
    try {
      const cached = await this.redis.client.get(nsKey);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }
    } catch (err) {
      this.logger.warn(`cache read failed for "${key}"; falling back to producer: ${String(err)}`);
      return producer();
    }

    const value = await producer();

    try {
      await this.redis.client.set(nsKey, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`cache write failed for "${key}": ${String(err)}`);
    }

    return value;
  }

  /**
   * Targeted, best-effort invalidation of cache keys matching a glob (e.g. after a
   * sync commit, ADR-040). Bounded SCAN (never a blocking KEYS), fail-open — a failure
   * is logged and returned as `-1` so the caller can record reconciliation/retry work
   * without ever rolling back a committed change. Returns the number of keys removed.
   */
  async invalidateByPattern(pattern: string): Promise<number> {
    const nsPattern = this.ns(pattern);
    try {
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', nsPattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) removed += await this.redis.client.del(...keys);
      } while (cursor !== '0');
      return removed;
    } catch (err) {
      this.logger.warn(`cache invalidation failed for "${pattern}": ${String(err)}`);
      return -1;
    }
  }
}
