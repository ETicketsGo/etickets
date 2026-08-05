import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import { InventoryResolver } from './inventory.resolver';
import { InventorySourcingModule } from './inventory-sourcing.module';

// Minimal global stand-in for the app's @Global PrismaModule, so the sourcing
// module's providers resolve PrismaService exactly as they do at runtime.
const prismaMock = { $queryRaw: jest.fn(), $transaction: jest.fn() } as unknown as PrismaService;

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prismaMock }],
  exports: [PrismaService],
})
class FakePrismaModule {}

describe('InventorySourcingModule (Nest DI boot)', () => {
  it('compiles the DI graph and registers the LOCAL providers on init', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ INVENTORY_AGGREGATOR_ENABLED: false })],
        }),
        FakePrismaModule,
        InventorySourcingModule,
      ],
    }).compile();
    // Triggers onModuleInit → factory.registerAll().
    await moduleRef.init();

    const registry = moduleRef.get(InventoryProviderRegistry);
    expect(registry.has('direct')).toBe(true);
    expect(registry.has('manual')).toBe(true);
    expect(registry.has('aggregator')).toBe(false); // flag off

    // The resolver is exported and wired with its collaborators.
    expect(moduleRef.get(InventoryResolver)).toBeInstanceOf(InventoryResolver);

    await moduleRef.close();
  });

  it('registers the aggregator placeholder when the flag is on', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ INVENTORY_AGGREGATOR_ENABLED: true })],
        }),
        FakePrismaModule,
        InventorySourcingModule,
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(InventoryProviderRegistry).has('aggregator')).toBe(true);
    await moduleRef.close();
  });
});
