import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

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

  constructor(private readonly redis: RedisService) {}

  async getOrSet<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.redis.client.get(key);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }
    } catch (err) {
      this.logger.warn(`cache read failed for "${key}"; falling back to producer: ${String(err)}`);
      return producer();
    }

    const value = await producer();

    try {
      await this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`cache write failed for "${key}": ${String(err)}`);
    }

    return value;
  }
}
