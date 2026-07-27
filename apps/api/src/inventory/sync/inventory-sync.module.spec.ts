import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CacheService } from '../../cache/cache.service';
import { AuditService } from '../../audit/audit.service';
import { SECRET_MANAGER } from '../../secrets/secret-manager.interface';
import { DOMAIN_EVENT_BUS } from '../../common/domain-events';
import { InventorySyncModule } from './inventory-sync.module';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { INVENTORY_SYNC_QUEUE } from './sync-queue.provider';

// @Global stand-ins for the app's global modules the sync module depends on.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: MetricsService, useValue: new MetricsService() },
    { provide: CacheService, useValue: {} },
    { provide: AuditService, useValue: { record: jest.fn() } },
    { provide: SECRET_MANAGER, useValue: { getSecret: jest.fn() } },
    {
      provide: DOMAIN_EVENT_BUS,
      useValue: { publish: jest.fn(), publishMany: jest.fn(), subscribe: jest.fn() },
    },
  ],
  exports: [
    PrismaService,
    MetricsService,
    CacheService,
    AuditService,
    SECRET_MANAGER,
    DOMAIN_EVENT_BUS,
  ],
})
class GlobalFakes {}

async function boot(mockEnabled: boolean) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ INVENTORY_SYNC_MOCK_PROVIDER_ENABLED: mockEnabled })],
      }),
      GlobalFakes,
      InventorySyncModule,
    ],
  })
    .overrideProvider(INVENTORY_SYNC_QUEUE)
    .useValue({ add: jest.fn() })
    .compile();
  await moduleRef.init();
  return moduleRef;
}

describe('InventorySyncModule (Nest DI boot)', () => {
  it('compiles the DI graph and registers the Manual adapter', async () => {
    const moduleRef = await boot(false);
    const registry = moduleRef.get(InventorySyncProviderRegistry);
    expect(registry.has('manual')).toBe(true);
    expect(registry.has('mock-aggregator')).toBe(false); // flag off
    await moduleRef.close();
  });

  it('registers the mock aggregator only when the flag is on', async () => {
    const moduleRef = await boot(true);
    expect(moduleRef.get(InventorySyncProviderRegistry).has('mock-aggregator')).toBe(true);
    await moduleRef.close();
  });
});
