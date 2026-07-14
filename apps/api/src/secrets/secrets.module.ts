import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectSecretManager } from './secret-manager.factory';
import { SECRET_MANAGER } from './secret-manager.interface';

/**
 * Provides the selected SecretManager (ADR-024) as a global singleton behind the
 * SECRET_MANAGER token. Global so the payment provider factory and readiness
 * endpoints can inject it without importing this module everywhere. Selection +
 * the production-safety guard (no env backend in protected environments) happen in
 * the factory at construction, so a misconfigured production fails fast on boot.
 */
@Global()
@Module({
  providers: [
    {
      provide: SECRET_MANAGER,
      inject: [ConfigService],
      useFactory: selectSecretManager,
    },
  ],
  exports: [SECRET_MANAGER],
})
export class SecretsModule {}
