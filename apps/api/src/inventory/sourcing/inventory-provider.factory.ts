import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../../common/errors';
import { AggregatorInventoryProvider } from './providers/aggregator.provider';
import { DirectInventoryProvider } from './providers/direct.provider';
import { ManualInventoryProvider } from './providers/manual.provider';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import type { InventoryProvider } from './inventory-provider.interface';

/**
 * Constructs and registers the available {@link InventoryProvider} adapters, mirroring
 * the payment provider factory (ADR-025). The LOCAL adapters (Direct/Manual) are always
 * registered; the placeholder Aggregator is registered ONLY when
 * `INVENTORY_AGGREGATOR_ENABLED` is set, so a disabled deployment cannot even resolve a
 * name it can't serve. Adding a real vendor is a new `case` here plus its adapter — no
 * consumer changes. See ADR-037.
 */
@Injectable()
export class InventoryProviderFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly registry: InventoryProviderRegistry,
    private readonly direct: DirectInventoryProvider,
    private readonly manual: ManualInventoryProvider,
    private readonly aggregator: AggregatorInventoryProvider,
  ) {}

  /**
   * Register every adapter this deployment should expose. Called once at module init
   * (see InventorySourcingModule). Idempotent — safe to call again after config change.
   */
  registerAll(): void {
    this.registry.register(this.direct);
    this.registry.register(this.manual);
    if (this.config.get<boolean>('INVENTORY_AGGREGATOR_ENABLED')) {
      this.registry.register(this.aggregator);
    }
  }

  /** Get a constructed adapter by name, or fail with a clear error. */
  get(name: string): InventoryProvider {
    const provider = this.registry.get(name);
    if (!provider) {
      throw new AppException(
        ErrorCodes.INVENTORY_PROVIDER_UNAVAILABLE,
        `No inventory provider named '${name}' is registered.`,
        HttpStatus.BAD_REQUEST,
        { name, available: this.registry.names() },
      );
    }
    return provider;
  }
}
