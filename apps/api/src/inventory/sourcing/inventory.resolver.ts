import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ExperienceType } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../../common/errors';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import { ProviderHealthMonitor } from './provider-health.monitor';
import { ProviderPriorityManager } from './provider-priority.manager';
import type { InventoryProvider } from './inventory-provider.interface';

/**
 * Where a resolution is happening — enough to pick and order providers. A show may
 * pin a `preferredProvider`; otherwise the priority manager's order is used. No
 * client-supplied field ever selects a provider (parity with payment routing).
 */
export interface ResolveContext {
  experienceType: ExperienceType;
  eventSessionId: string;
  /** Optional trusted pin (e.g. a show sourced from a specific provider). */
  preferredProvider?: string;
}

/**
 * Selects the {@link InventoryProvider} for a booking and provides automatic
 * failover — the piece that makes "unlimited providers, no business logic depends on
 * one" real (ADR-037).
 *
 * Selection order = ProviderPriorityManager, with any trusted pin moved to the front,
 * filtered to providers the ProviderHealthMonitor currently believes healthy.
 *
 * Failover rule: `withFailover` attempts the primary, then the next candidate, and so
 * on — but ONLY steps past a provider whose `capabilities.failover` is true. An
 * authoritative LOCAL provider (failover=false) never fails over: a real sold-out /
 * conflict is the answer and must surface, not be masked by trying another source.
 */
@Injectable()
export class InventoryResolver {
  private readonly logger = new Logger(InventoryResolver.name);

  constructor(
    private readonly priority: ProviderPriorityManager,
    private readonly health: ProviderHealthMonitor,
    private readonly registry: InventoryProviderRegistry,
  ) {}

  /** The single best healthy provider for a context. Throws if none is available. */
  async resolve(ctx: ResolveContext): Promise<InventoryProvider> {
    const [primary] = await this.candidates(ctx);
    if (!primary) {
      throw this.unavailable(ctx);
    }
    return primary;
  }

  /** Ordered HEALTHY candidates, most-preferred first (primary + failover targets). */
  async candidates(ctx: ResolveContext): Promise<InventoryProvider[]> {
    const order = this.orderedNames(ctx);
    const out: InventoryProvider[] = [];
    for (const name of order) {
      const provider = this.registry.get(name);
      if (!provider) continue;
      if (!(await this.health.isHealthy(name))) continue;
      out.push(provider);
    }
    return out;
  }

  /**
   * Run `op` against the primary provider, failing over to the next healthy candidate
   * when the current provider both throws AND permits failover. Returns the first
   * success; rethrows the last error when no candidate succeeds.
   */
  async withFailover<T>(
    ctx: ResolveContext,
    op: (provider: InventoryProvider) => Promise<T>,
  ): Promise<T> {
    const candidates = await this.candidates(ctx);
    if (candidates.length === 0) {
      throw this.unavailable(ctx);
    }
    let lastError: unknown;
    for (const provider of candidates) {
      try {
        return await op(provider);
      } catch (err) {
        lastError = err;
        // An authoritative source's error IS the answer — never mask it by retrying
        // elsewhere. Stop and propagate.
        if (!provider.capabilities.failover) throw err;
        // Otherwise treat this provider as degraded and try the next candidate.
        this.health.invalidate(provider.name);
        this.logger.warn(`inventory op failed on provider '${provider.name}'; attempting failover`);
      }
    }
    throw lastError;
  }

  private orderedNames(ctx: ResolveContext): string[] {
    const base = this.priority.order();
    const pin = ctx.preferredProvider?.toLowerCase();
    if (!pin || !this.registry.has(pin)) return base;
    return [pin, ...base.filter((n) => n !== pin)];
  }

  private unavailable(ctx: ResolveContext): AppException {
    return new AppException(
      ErrorCodes.INVENTORY_PROVIDER_UNAVAILABLE,
      'No healthy inventory provider is available to serve this request.',
      HttpStatus.SERVICE_UNAVAILABLE,
      { experienceType: ctx.experienceType, eventSessionId: ctx.eventSessionId },
    );
  }
}
