import { Module, OnModuleInit } from '@nestjs/common';
import { InventoryModule } from '../inventory.module';
import { AggregatorInventoryProvider } from './providers/aggregator.provider';
import { DirectInventoryProvider } from './providers/direct.provider';
import { ManualInventoryProvider } from './providers/manual.provider';
import { InventoryProviderFactory } from './inventory-provider.factory';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import { InventoryResolver } from './inventory.resolver';
import { ProviderHealthMonitor } from './provider-health.monitor';
import { ProviderPriorityManager } from './provider-priority.manager';

/**
 * The inventory SOURCING seam (ADR-037): a provider-agnostic layer that lets stock
 * come from our own DB (Direct/Manual) or future external sources (Aggregator)
 * behind one interface, with a registry, resolver, health monitor, priority manager
 * and automatic failover.
 *
 * Importing this module changes NO existing behaviour: it only constructs and
 * registers the provider adapters. The booking engine keeps its current direct path
 * until a show is explicitly routed through {@link InventoryResolver} in a later
 * phase (gated by INVENTORY_SOURCING_ENABLED). LOCAL providers delegate to the
 * existing InventoryStrategy (ADR-010), so no inventory maths is duplicated.
 */
@Module({
  imports: [InventoryModule],
  providers: [
    DirectInventoryProvider,
    ManualInventoryProvider,
    AggregatorInventoryProvider,
    InventoryProviderRegistry,
    InventoryProviderFactory,
    ProviderHealthMonitor,
    ProviderPriorityManager,
    InventoryResolver,
  ],
  exports: [InventoryResolver, InventoryProviderRegistry, ProviderHealthMonitor],
})
export class InventorySourcingModule implements OnModuleInit {
  constructor(private readonly factory: InventoryProviderFactory) {}

  /** Register the available adapters once the module (and its config) is ready. */
  onModuleInit(): void {
    this.factory.registerAll();
  }
}
