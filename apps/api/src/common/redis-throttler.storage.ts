import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../redis/redis.service';
import { throttleKeyPrefix } from './redis-namespace';

/**
 * Rate-limit counters that survive a restart and are shared between replicas.
 *
 * ── THE FAILURE THIS CLOSES ────────────────────────────────────────────────────────
 * `@nestjs/throttler` defaults to in-memory storage, so the credential-route limit
 * (10 attempts a minute) lived in one API process. Two consequences, both real:
 *
 *   - **It is lost on every restart and cold start.** An attacker does not need to beat the
 *     limit; they need the process to restart, which a deploy does on schedule.
 *   - **It multiplies by the replica count.** Production runs one replica today, so the limit
 *     is honest today. The moment anybody scales to two for a sale, password guessing gets
 *     twice the budget and nothing says so.
 *
 * Redis is already provisioned and `ioredis` is already a dependency, so this needs no new
 * package - which is most of the reason to do it this way rather than adding one.
 *
 * ── WHY IT DEGRADES RATHER THAN FAILING EITHER WAY ─────────────────────────────────
 * The two obvious behaviours when Redis is unreachable are both wrong:
 *
 *   - **Fail closed** (refuse the request) makes Redis an availability dependency for every
 *     login. A Redis blip during an on-sale would lock out every customer, and it converts a
 *     cache outage into a total authentication outage. Refusing to let people sign in is not
 *     a security win.
 *   - **Fail open** (allow, uncounted) removes the limit for exactly as long as an attacker
 *     can keep Redis under pressure, which hands them the mechanism.
 *
 * So it falls back to the in-memory counter it was replacing. The limit still applies; it is
 * merely per-process again, which is strictly better than none and no worse than the state
 * this class was introduced to improve on. The degradation is logged once per transition, so
 * it is visible rather than silent.
 *
 * Authentication itself is untouched by any of this. A throttle decides how OFTEN a credential
 * may be presented, never whether it is correct.
 */
/**
 * Where rate-limit counters are kept. `memory` unless somebody chooses otherwise.
 *
 * Anything unrecognised reads as `memory`, so a typo degrades to the behaviour this platform
 * has always had rather than to an unintended one. The DEFAULT is what production runs, which
 * is why it is the case the tests pin hardest.
 */
export function throttlerStorageMode(config: {
  get<T>(key: string): T | undefined;
}): 'memory' | 'redis' {
  const raw = (config.get<string>('THROTTLE_STORAGE') ?? '').trim().toLowerCase();
  return raw === 'redis' ? 'redis' : 'memory';
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  /** The storage this replaces, kept as the degraded path. */
  private readonly fallback = new ThrottlerStorageService();

  private readonly prefix: string;

  /** Logged on each transition only, so an outage does not also flood the log. */
  private degraded = false;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.prefix = `${throttleKeyPrefix(config.get<string>('APP_ENV'))}:`;
  }

  /**
   * Count one hit against `key`.
   *
   * ── WHY THIS IS ONE SCRIPT AND NOT INCR THEN EXPIRE ────────────────────────────
   * `INCR` followed by `EXPIRE` is two round trips, and a process that dies between them
   * leaves a counter with no expiry - a key that never resets, which locks a legitimate user
   * out of their own account permanently. Redis runs a script atomically, so the window does
   * not exist.
   *
   * The block key is separate from the counter so that serving a blocked caller costs one
   * lookup and does not extend their own block - a blocked client that keeps hammering should
   * not be able to lengthen its penalty indefinitely, because the penalty is then unbounded
   * by configuration and nobody intended that.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `${this.prefix}${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    try {
      const result = (await this.redis.client.eval(
        INCREMENT_SCRIPT,
        2,
        hitKey,
        blockKey,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number, number];

      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Rate-limit counters are shared again (Redis reachable).');
      }

      const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result;
      return {
        totalHits,
        timeToExpire,
        isBlocked: isBlocked === 1,
        timeToBlockExpire,
      };
    } catch (err) {
      /*
        Degraded, not disabled. See the class comment: refusing logins because a cache is
        unreachable is a worse outcome than counting per-process for a few minutes.
      */
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn(
          'Rate-limit counters have fallen back to per-process memory: Redis is unreachable. ' +
            'Limits still apply, but they are no longer shared between replicas or kept across ' +
            `a restart. Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}

/**
 * KEYS[1] counter, KEYS[2] block marker. ARGV ttl, limit, blockDuration (all seconds).
 *
 * Returns [totalHits, timeToExpire, isBlocked, timeToBlockExpire], matching the in-memory
 * storage's record so the guard cannot tell the two apart.
 *
 * `ttl` and `blockDuration` arrive in SECONDS from the throttler, and the record wants seconds
 * back. Using PTTL and dividing would introduce rounding for no benefit, so this stays in
 * whole seconds throughout - the same unit the configuration is written in.
 */
const INCREMENT_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

-- Already serving a penalty: report it without counting the hit or extending the block.
local blockTtl = redis.call('TTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitKey) or '0')
  return { hits, blockTtl, 1, blockTtl }
end

local hits = redis.call('INCR', hitKey)
if hits == 1 then
  redis.call('EXPIRE', hitKey, ttl)
end
local expire = redis.call('TTL', hitKey)
if expire < 0 then
  -- A counter with no expiry would never reset and would lock the caller out for good.
  redis.call('EXPIRE', hitKey, ttl)
  expire = ttl
end

if hits > limit and blockDuration > 0 then
  redis.call('SET', blockKey, '1', 'EX', blockDuration)
  return { hits, expire, 1, blockDuration }
end

return { hits, expire, 0, 0 }
`;
