import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { bullPrefix } from '../../common/redis-namespace';

/** DI token for the enqueue-only BullMQ client for the inventory-sync queue. */
export const INVENTORY_SYNC_QUEUE = 'INVENTORY_SYNC_QUEUE';

/** The single queue for async inventory-sync event processing (ADR-040). */
export const INVENTORY_SYNC_QUEUE_NAME = 'inventory-sync-events';

/** The job payload — IDENTIFIERS ONLY, never the raw provider payload (ADR-040 §9). */
export interface InventorySyncJob {
  rawEventId: string;
  providerCode: string;
  correlationId?: string;
}

/**
 * A BullMQ {@link Queue} client for the inventory-sync queue, reusing the same
 * REDIS_URL/connection shape as the existing `holds` queue provider — no new queue
 * framework. The API side only ENQUEUES; the worker registers the processor. Jobs
 * carry only ids; the worker reloads the durable RawProviderEvent from PostgreSQL.
 */
export const inventorySyncQueueProvider: Provider = {
  provide: INVENTORY_SYNC_QUEUE,
  useFactory: (config: ConfigService): Queue => {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const url = new URL(redisUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      maxRetriesPerRequest: null as null,
    };
    const maxAttempts = Number(config.get<string>('INVENTORY_SYNC_MAX_ATTEMPTS') ?? 6);
    return new Queue<InventorySyncJob>(INVENTORY_SYNC_QUEUE_NAME, {
      connection,
      prefix: bullPrefix(config.get('APP_ENV')), // env-scoped keyspace (P6.2)
      defaultJobOptions: {
        attempts: maxAttempts,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  },
  inject: [ConfigService],
};
