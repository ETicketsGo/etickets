import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { RedisService } from '../redis/redis.service';
import { clientIpTracker, resolveClientIpHeader } from './client-ip';
import { RedisThrottlerStorage, throttlerStorageMode } from './redis-throttler.storage';

/**
 * The one place the application's rate limiting is assembled: limits, storage and the key.
 *
 * App module and tests build it through the same function, so a test that runs two
 * application instances against one store is testing the production wiring rather than a copy.
 */

const MINUTE_MS = 60_000;

/**
 * Credential routes: password sign-in, phone code request and verify, MFA verify and enrolment,
 * password reset, register and token refresh. 10 per minute per client per route, blocked for
 * the rest of a minute once exceeded.
 *
 * Counted per ROUTE as well as per client (the guard keys on controller + handler), so a
 * customer who mistypes a password five times can still ask for a reset link.
 *
 * `AUTH_THROTTLE_LIMIT` exists ONLY so a login-heavy local or e2e run (many suites, one IP, one
 * minute) does not trip it. Deployed environments leave it unset and get 10.
 */
export const AUTH_THROTTLE = {
  default: {
    limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10),
    ttl: MINUTE_MS,
    blockDuration: MINUTE_MS,
  },
};

interface ConfigLike {
  get<T>(key: string): T | undefined;
}

export function throttlerOptions(
  config: ConfigLike,
  redis: RedisService,
  env: NodeJS.ProcessEnv = process.env,
): ThrottlerModuleOptions {
  /*
    The trusted header is decided once, at boot, from the environment: whether Railway is in
    front of this process does not change between requests. `RAILWAY_ENVIRONMENT_ID` is read
    from the raw environment because Railway injects it and the config schema does not (and
    should not) know about it.
  */
  const header = resolveClientIpHeader({
    THROTTLE_CLIENT_IP_HEADER: config.get<string>('THROTTLE_CLIENT_IP_HEADER'),
    RAILWAY_ENVIRONMENT_ID: env.RAILWAY_ENVIRONMENT_ID,
  });
  return {
    throttlers: [
      {
        ttl: Number(env.THROTTLE_TTL_MS ?? MINUTE_MS),
        limit: Number(env.THROTTLE_LIMIT ?? 120),
      },
    ],
    getTracker: clientIpTracker(header),
    ...(throttlerStorageMode(config) === 'redis'
      ? { storage: new RedisThrottlerStorage(redis, config as never) }
      : {}),
  };
}
