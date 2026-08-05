import { Injectable } from '@nestjs/common';
import type { InventoryProvider } from './inventory-provider.interface';

/**
 * Registry of constructed {@link InventoryProvider} adapters, keyed by name. Mirrors
 * the PaymentProviderRegistry pattern (ADR-021): the resolver, health monitor and
 * priority manager reach providers only through this registry, so new sources are
 * added by registering an adapter — no consumer changes. See ADR-037.
 */
@Injectable()
export class InventoryProviderRegistry {
  private readonly byName = new Map<string, InventoryProvider>();

  register(provider: InventoryProvider): void {
    this.byName.set(provider.name.toLowerCase(), provider);
  }

  get(name: string): InventoryProvider | undefined {
    return this.byName.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }

  /** All registered adapters (deduped). */
  list(): InventoryProvider[] {
    return Array.from(new Set(this.byName.values()));
  }

  /** Registered adapter names, in registration order. */
  names(): string[] {
    return Array.from(this.byName.keys());
  }
}
