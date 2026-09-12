import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { Redis } from 'ioredis';
import { resolveRedisUrl } from '../config/redis-url';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    /*
      Refuses to construct -- and so refuses to boot the application -- when a deployed
      environment has no REDIS_URL or points it at localhost. Every consumer of this client is
      fail-open, so without the refusal a lost variable is a service that looks healthy and
      quietly does none of its Redis work.
    */
    const url = resolveRedisUrl(config.get<string>('REDIS_URL'), config.get<string>('APP_ENV'));
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
