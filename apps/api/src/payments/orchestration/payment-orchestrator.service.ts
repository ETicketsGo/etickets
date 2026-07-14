import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
import { AuditService } from '../../audit/audit.service';
import { MetricsService } from '../../metrics/metrics.service';
import { isFailClosed } from '../configuration/payment-environment';
import {
  PaymentConfigService,
  type PaymentContext,
  type ResolvedProviderTarget,
} from '../configuration/payment-config.service';
import {
  PAYMENT_PROVIDER,
  type CreatePaymentInput,
  type PaymentIntent,
  type PaymentProvider,
  type RefundInput,
  type RefundResult,
} from '../provider/payment-provider.interface';
import { CircuitBreaker } from './circuit-breaker';
import { PaymentProviderRegistry } from './provider-registry';
import { executeWithFailover, type ExecutionCandidate } from './resilient-executor';

/** Default operational controls used for the fallback/default provider path. */
const DEFAULT_OPS = {
  timeoutMs: 15_000,
  maxRetries: 2,
  retryBackoffMs: 500,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 30_000,
};

export interface CreatePaymentResult {
  intent: PaymentIntent;
  provider: string;
}

/**
 * Payment orchestrator (ADR-021). Sits between the booking engine and the provider
 * adapters: it resolves the routed provider chain (primary + failover) for a
 * payment context, then executes the operation with per-provider circuit breaking,
 * bounded retries, timeouts and failover.
 *
 * Backward compatible: when runtime configuration cannot resolve a usable provider
 * (e.g. local/dev with only the dummy provider, or an unconfigured route) it falls
 * back to the env-selected default provider — exactly today's single-provider
 * behavior. In a fail-closed environment (staging/production) an unresolvable or
 * unavailable provider surfaces as an error instead of a silent fallback.
 */
@Injectable()
export class PaymentOrchestrator {
  private readonly logger = new Logger(PaymentOrchestrator.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: PaymentConfigService,
    private readonly registry: PaymentProviderRegistry,
    @Inject(PAYMENT_PROVIDER) private readonly defaultProvider: PaymentProvider,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** Create a payment intent, routing + failing over per runtime configuration. */
  async createPayment(
    context: PaymentContext,
    input: CreatePaymentInput,
  ): Promise<CreatePaymentResult> {
    const targets = await this.resolveTargets(context);
    let used = '';
    const candidates: ExecutionCandidate<PaymentIntent>[] = targets.map((t) => ({
      provider: t.name,
      breaker: this.breakerFor(t.name, t.circuitFailureThreshold, t.circuitCooldownMs),
      timeoutMs: t.timeoutMs,
      maxRetries: t.maxRetries,
      retryBackoffMs: t.retryBackoffMs,
      run: async () => {
        const intent = await t.provider.createPayment(input);
        used = t.name;
        return intent;
      },
    }));

    if (candidates.length > 1) {
      this.logger.log(
        `Payment routing for ${context.country ?? '*'}/${context.currency}: ${candidates
          .map((c) => c.provider)
          .join(' → ')}`,
      );
    }
    const intent = await executeWithFailover(candidates);

    // Failover safety: createPayment happens BEFORE any irreversible capture (which
    // is confirmed later via webhook), so failing over here never risks a double
    // charge. Record the decision + alert, preserving the original attempt.
    const primary = candidates[0]?.provider;
    if (used && primary && used !== primary) {
      this.logger.warn(`Payment failover: ${primary} → ${used} (pre-capture).`);
      this.metrics?.recordPaymentWebhook(used, 'failover');
      await this.audit?.record({
        action: 'PAYMENT_FAILOVER',
        entityType: 'Payment',
        entityId: input.bookingId,
        metadata: { originalProvider: primary, usedProvider: used, currency: input.currency },
      });
    }
    return { intent, provider: used };
  }

  /** Operator control: force a provider's circuit OPEN (activate failover away). */
  async activateFailover(provider: string, actor?: { userId?: string }): Promise<void> {
    this.breakerFor(provider, 5, 30_000).forceOpen();
    this.logger.warn(`Failover activated for '${provider}' (circuit forced OPEN).`);
    await this.audit?.record({
      actorUserId: actor?.userId,
      action: 'PAYMENT_FAILOVER_ACTIVATED',
      entityType: 'PaymentProvider',
      entityId: provider,
      metadata: { provider },
    });
  }

  /** Operator control: reset a provider's circuit to CLOSED (roll failover back). */
  async rollbackFailover(provider: string, actor?: { userId?: string }): Promise<void> {
    this.breakerFor(provider, 5, 30_000).reset();
    this.logger.log(`Failover rolled back for '${provider}' (circuit reset).`);
    await this.audit?.record({
      actorUserId: actor?.userId,
      action: 'PAYMENT_FAILOVER_ROLLED_BACK',
      entityType: 'PaymentProvider',
      entityId: provider,
      metadata: { provider },
    });
  }

  /**
   * Refund a captured payment. Refunds have provider affinity — the refund must go
   * to the provider that took the payment — so there is NO cross-provider failover,
   * only retry/timeout/circuit protection on that one provider.
   */
  async refund(input: RefundInput, opts: { provider?: string } = {}): Promise<RefundResult> {
    const provider =
      (opts.provider ? this.registry.get(opts.provider) : undefined) ?? this.defaultProvider;
    const name = provider.name;
    const candidate: ExecutionCandidate<RefundResult> = {
      provider: name,
      breaker: this.breakerFor(
        name,
        DEFAULT_OPS.circuitFailureThreshold,
        DEFAULT_OPS.circuitCooldownMs,
      ),
      timeoutMs: DEFAULT_OPS.timeoutMs,
      maxRetries: DEFAULT_OPS.maxRetries,
      retryBackoffMs: DEFAULT_OPS.retryBackoffMs,
      run: () => provider.refund(input),
    };
    return executeWithFailover([candidate]);
  }

  /**
   * Resolve the ordered provider candidates for a context. Falls back to the default
   * provider when configuration cannot yield a usable adapter, unless the environment
   * must fail closed.
   */
  private async resolveTargets(context: PaymentContext): Promise<ResolvedCandidate[]> {
    const env = this.config.environment;
    let primaryName: string | undefined;
    let failoverName: string | undefined;
    let resolved: { primary: ResolvedProviderTarget; failover?: ResolvedProviderTarget } | null =
      null;
    try {
      const target = await this.config.resolveTarget(context);
      resolved = { primary: target.primary, failover: target.failover };
      primaryName = target.primary.provider;
      failoverName = target.failover?.provider;
    } catch (err) {
      // No route / disabled provider. Fail closed in staging/production.
      if (isFailClosed(env)) throw err;
      this.logger.warn(
        `Payment config unresolved in ${env}; using default provider. ${
          err instanceof Error ? err.message : ''
        }`,
      );
    }

    const candidates: ResolvedCandidate[] = [];
    if (resolved) {
      this.pushIfAvailable(candidates, primaryName, resolved.primary);
      this.pushIfAvailable(candidates, failoverName, resolved.failover);
    }

    if (candidates.length === 0) {
      if (isFailClosed(env)) {
        // A route resolved but no matching adapter is constructed in this process.
        throw new AppException(
          ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
          `No usable payment provider for ${context.currency} in ${env}.`,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      candidates.push(this.defaultCandidate());
    }
    return candidates;
  }

  private pushIfAvailable(
    into: ResolvedCandidate[],
    name: string | undefined,
    target: ResolvedProviderTarget | undefined,
  ): void {
    if (!name || !target) return;
    const provider = this.registry.get(name);
    if (!provider) {
      this.logger.warn(`Routed provider '${name}' has no constructed adapter; skipping.`);
      return;
    }
    into.push({
      name: provider.name,
      provider,
      timeoutMs: target.ops.timeoutMs,
      maxRetries: target.ops.maxRetries,
      retryBackoffMs: target.ops.retryBackoffMs,
      circuitFailureThreshold: target.ops.circuitFailureThreshold,
      circuitCooldownMs: target.ops.circuitCooldownMs,
    });
  }

  private defaultCandidate(): ResolvedCandidate {
    return {
      name: this.defaultProvider.name,
      provider: this.defaultProvider,
      ...DEFAULT_OPS,
    };
  }

  private breakerFor(name: string, threshold: number, cooldownMs: number): CircuitBreaker {
    const key = name.toLowerCase();
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker({ failureThreshold: threshold, cooldownMs });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  /** Whether a provider's circuit breaker is currently OPEN (short-circuiting). */
  isCircuitOpen(name: string): boolean {
    const breaker = this.breakers.get(name.toLowerCase());
    return breaker ? !breaker.canAttempt() : false;
  }

  /** Current circuit state per known provider (for observability / readiness). */
  circuitStates(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, breaker] of this.breakers) out[name] = breaker.currentState();
    return out;
  }
}

interface ResolvedCandidate {
  name: string;
  provider: PaymentProvider;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
}
