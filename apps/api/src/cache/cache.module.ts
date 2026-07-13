import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * Global cache module. Depends on the (already global) RedisModule and exposes
 * a single reusable {@link CacheService}. Global so read paths can inject it
 * without threading an import through every feature module.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
