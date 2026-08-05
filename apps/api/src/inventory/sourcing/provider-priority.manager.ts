import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InventoryProviderRegistry } from './inventory-provider.registry';

/**
 * Owns the ORDER in which providers are tried for a given inventory item. The
 * resolver walks this order (skipping unhealthy providers) to pick a primary and to
 * fail over. Order is config-driven (`INVENTORY_PROVIDER_PRIORITY`, a comma-separated
 * name list) with a safe default that always prefers LOCAL authoritative stock
 * (direct, then manual) before any external source. See ADR-037.
 */
@Injectable()
export class ProviderPriorityManager {
  /** Default order when nothing is configured: LOCAL first, external last. */
  private static readonly DEFAULT_ORDER = ['direct', 'manual', 'aggregator'];

  constructor(
    private readonly config: ConfigService,
    private readonly registry: InventoryProviderRegistry,
  ) {}

  /**
   * The ordered list of REGISTERED provider names to try, most-preferred first.
   * Configured names come first (in the given order); any registered provider not
   * named in config is appended in the default order so it is never silently dropped.
   */
  order(): string[] {
    const configured = (this.config.get<string>('INVENTORY_PROVIDER_PRIORITY') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const registered = new Set(this.registry.names());
    const seen = new Set<string>();
    const result: string[] = [];

    const push = (name: string): void => {
      if (registered.has(name) && !seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    };

    for (const name of configured) push(name);
    for (const name of ProviderPriorityManager.DEFAULT_ORDER) push(name);
    // Any remaining registered providers (e.g. a new vendor not yet in the default
    // list) come last, so they are candidates without needing a code change here.
    for (const name of this.registry.names()) push(name);

    return result;
  }
}
