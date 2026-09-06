import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { SyncIngestionService } from './sync-ingestion.service';
import { SyncEventProcessor } from './sync-event.processor';
import { SyncApplicationService } from './sync-application.service';
import { SyncCheckpointService } from './sync-checkpoint.service';
import { SyncPollingService } from './sync-polling.service';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { ProviderSyncHealthService } from './sync-health.service';
import { SyncOpsService } from './sync-ops.service';
import { ManualInventorySyncProvider } from './providers/manual-sync.provider';
import { MockAggregatorInventorySyncProvider } from './providers/mock-aggregator-sync.provider';
import { QubeMockInventorySyncProvider } from './providers/qube-mock-sync.provider';
import { InventorySourcingModule } from '../sourcing/inventory-sourcing.module';
import { SyncWebhookController } from './sync-webhook.controller';
import { SyncOpsController } from './sync-ops.controller';
import { inventorySyncQueueProvider } from './sync-queue.provider';

/**
 * External inventory synchronization platform (ADR-040). Depends only on @Global
 * modules (Prisma, Redis, Metrics, Cache, Secrets, Audit, P2 DomainEvents) — no cycles.
 * Registers the Manual reference adapter always, and the dev/test-only Mock aggregator
 * ONLY when INVENTORY_SYNC_MOCK_PROVIDER_ENABLED. Importing the module changes no
 * behaviour: every path is gated by INVENTORY_SYNC_* flags (all off by default) and the
 * webhook route fails closed when disabled.
 */
@Module({
  // Sourcing is imported for the Qube sandbox instance only: the sync adapter must read the
  // SAME cinema the booking path sells from.
  imports: [InventorySourcingModule],
  controllers: [SyncWebhookController, SyncOpsController],
  providers: [
    inventorySyncQueueProvider,
    InventorySyncProviderRegistry,
    SyncIngestionService,
    SyncApplicationService,
    SyncEventProcessor,
    SyncCheckpointService,
    SyncPollingService,
    SyncReconciliationService,
    ProviderSyncHealthService,
    SyncOpsService,
    ManualInventorySyncProvider,
    MockAggregatorInventorySyncProvider,
    QubeMockInventorySyncProvider,
  ],
  exports: [
    SyncEventProcessor,
    SyncPollingService,
    SyncReconciliationService,
    ProviderSyncHealthService,
    InventorySyncProviderRegistry,
  ],
})
export class InventorySyncModule implements OnModuleInit {
  constructor(
    private readonly registry: InventorySyncProviderRegistry,
    private readonly config: ConfigService,
    private readonly manual: ManualInventorySyncProvider,
    private readonly mock: MockAggregatorInventorySyncProvider,
    private readonly qubeMock: QubeMockInventorySyncProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.manual);
    if (this.config.get<boolean>('INVENTORY_SYNC_MOCK_PROVIDER_ENABLED')) {
      this.registry.register(this.mock);
    }
    /*
      One switch for one sandbox. The Qube sandbox has three adapters — inventory authority,
      booking lifecycle, catalogue sync — and they describe the same invented cinema, so
      registering them independently would let a deployment sell from a catalogue it cannot
      sync, or sync one it cannot sell. `INVENTORY_QUBE_MOCK_ENABLED` turns on all three.
    */
    if (this.config.get<boolean>('INVENTORY_QUBE_MOCK_ENABLED')) {
      this.registry.register(this.qubeMock);
    }
  }
}
