import { Injectable, Logger } from '@nestjs/common';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import type { InventoryProvider, ProviderHealth } from './inventory-provider.interface';

interface CachedHealth {
  health: ProviderHealth;
  /** epoch ms when this result was captured. */
  at: number;
}

/**
 * Tracks per-provider health so the resolver can skip a failing source and fail over
 * without probing on every booking. Health is cached for a short TTL (a lightweight
 * circuit breaker): a fresh cached result is reused; a stale/absent one triggers a
 * live `provider.health()` probe. A probe that throws counts as unhealthy — it never
 * blocks the caller indefinitely. See ADR-037.
 */
@Injectable()
export class ProviderHealthMonitor {
  private readonly logger = new Logger(ProviderHealthMonitor.name);
  private readonly cache = new Map<string, CachedHealth>();

  /** How long a health result is trusted before re-probing (ms). */
  private readonly ttlMs = 10_000;

  constructor(private readonly registry: InventoryProviderRegistry) {}

  /** True iff the named provider is currently believed healthy. */
  async isHealthy(name: string): Promise<boolean> {
    const provider = this.registry.get(name);
    if (!provider) return false;
    return (await this.check(provider)).healthy;
  }

  /** Health for one provider (cached within the TTL). */
  async check(provider: InventoryProvider, now: number = Date.now()): Promise<ProviderHealth> {
    const key = provider.name.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < this.ttlMs) return cached.health;

    let health: ProviderHealth;
    try {
      health = await provider.health();
    } catch (err) {
      health = {
        healthy: false,
        reason: err instanceof Error ? err.name : 'health_check_threw',
        checkedAt: new Date(now),
      };
      this.logger.warn(`inventory provider '${provider.name}' health probe failed`);
    }
    this.cache.set(key, { health, at: now });
    return health;
  }

  /** Health snapshot for every registered provider (for ops dashboards). */
  async snapshot(): Promise<Record<string, ProviderHealth>> {
    const out: Record<string, ProviderHealth> = {};
    for (const provider of this.registry.list()) {
      out[provider.name] = await this.check(provider);
    }
    return out;
  }

  /** Drop a cached result so the next check re-probes immediately. */
  invalidate(name: string): void {
    this.cache.delete(name.toLowerCase());
  }
}
