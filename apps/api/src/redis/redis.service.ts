import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    // commandTimeout + no offline queue so commands REJECT quickly when Redis is
    // unreachable instead of hanging indefinitely — this is what lets the fail-open
    // consumers (cache, maintenance guard) actually degrade gracefully on an outage.
    this.client = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
      commandTimeout: Number(config.get<string>('REDIS_COMMAND_TIMEOUT_MS') ?? 1000),
      enableOfflineQueue: false,
    });
    // ioredis emits 'error' on connection loss; without a listener it can crash the
    // process. Swallow — consumers already handle command-level failures fail-open.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
