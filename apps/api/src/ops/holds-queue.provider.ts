import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { bullConnectionFromUrl, bullPrefix } from '../common/redis-namespace';

/** DI token for the read/manage-only BullMQ client for the worker's `holds` queue. */
export const HOLDS_QUEUE = 'HOLDS_QUEUE';

/** The single queue the worker processes (see apps/worker/src/main.ts). */
export const HOLDS_QUEUE_NAME = 'holds';

/**
 * A BullMQ {@link Queue} client for the `holds` queue, reusing the exact same
 * REDIS_URL/connection settings the worker uses (host/port from REDIS_URL,
 * `maxRetriesPerRequest: null`). This client only READS and MANAGES jobs
 * (counts, failed listing, retry) — it never registers a processor, so it does
 * not compete with the worker. It is a singleton; OpsService closes it in
 * onModuleDestroy.
 */
export const holdsQueueProvider: Provider = {
  provide: HOLDS_QUEUE,
  useFactory: (config: ConfigService): Queue => {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    // Mirror the worker's plain-options connection shape exactly (same helper on both sides),
    // including credentials/db/TLS from the URL so managed Redis authenticates.
    const connection = bullConnectionFromUrl(redisUrl);
    // Env-scoped prefix so staging/production never share the `holds` queue keyspace (P6.2).
    return new Queue(HOLDS_QUEUE_NAME, { connection, prefix: bullPrefix(config.get('APP_ENV')) });
  },
  inject: [ConfigService],
};
