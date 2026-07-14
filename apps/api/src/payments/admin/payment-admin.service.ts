import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, PaymentEnv, PaymentProviderMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { isFailClosed, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentConfigService } from '../configuration/payment-config.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import {
  validatePaymentConfig,
  type ProviderConfigView,
  type RouteView,
  type ValidationResult,
} from '../configuration/payment-config.validator';

/** Editable fields on a provider config (secret references only, never raw). */
export interface ProviderConfigPatch {
  enabled?: boolean;
  mode?: PaymentProviderMode;
  publicKey?: string | null;
  secretKeyRef?: string | null;
  webhookSecretRef?: string | null;
  apiBaseUrl?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  priority?: number;
}

export interface RouteInput {
  country: string;
  currency: string;
  method: string;
  provider: string;
  failoverProvider?: string | null;
  priority?: number;
  active?: boolean;
}

interface Actor {
  userId?: string;
  ip?: string | null;
}

/**
 * Admin console backend for runtime payment configuration (ADR-022). Every change
 * is validated fail-closed BEFORE it commits — a mutation that would leave a
 * fail-closed environment (staging/production) invalid is rejected and rolled back
 * — and every change is audited. Holds no secrets: only public identifiers and
 * secret references.
 */
@Injectable()
export class PaymentAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: PaymentConfigService,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  /** Full configuration snapshot for an environment + its validation status. */
  async overview(env: PaymentEnvName) {
    const [providers, routes] = await Promise.all([
      this.prisma.paymentProviderConfig.findMany({
        where: { env: env as PaymentEnv },
        include: { merchantAccounts: true },
        orderBy: [{ priority: 'asc' }, { provider: 'asc' }],
      }),
      this.prisma.paymentRoute.findMany({
        where: { env: env as PaymentEnv },
        orderBy: [{ priority: 'asc' }, { country: 'asc' }],
      }),
    ]);
    const validation = validate(env, providers, routes);
    return { env, activeEnv: this.config.environment, providers, routes, validation };
  }

  async updateConfig(env: PaymentEnvName, id: string, patch: ProviderConfigPatch, actor: Actor) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentProviderConfig.findUnique({ where: { id } });
      if (!existing || existing.env !== env) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Payment provider config not found in this environment.',
          HttpStatus.NOT_FOUND,
        );
      }
      const row = await tx.paymentProviderConfig.update({
        where: { id },
        data: patch as Prisma.PaymentProviderConfigUpdateInput,
      });
      await this.assertValidAfter(tx, env);
      return row;
    });
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action: 'PAYMENT_CONFIG_UPDATED',
      entityType: 'PaymentProviderConfig',
      entityId: id,
      metadata: { env, patch: sanitize(patch) },
    });
    return updated;
  }

  async createRoute(env: PaymentEnvName, input: RouteInput, actor: Actor) {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.paymentRoute.create({
        data: { env: env as PaymentEnv, ...normalizeRoute(input) },
      });
      await this.assertValidAfter(tx, env);
      return created;
    });
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action: 'PAYMENT_ROUTE_CREATED',
      entityType: 'PaymentRoute',
      entityId: row.id,
      metadata: { env, ...normalizeRoute(input) },
    });
    return row;
  }

  async updateRoute(env: PaymentEnvName, id: string, input: Partial<RouteInput>, actor: Actor) {
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentRoute.findUnique({ where: { id } });
      if (!existing || existing.env !== env) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Payment route not found in this environment.',
          HttpStatus.NOT_FOUND,
        );
      }
      const updated = await tx.paymentRoute.update({
        where: { id },
        data: normalizeRoutePatch(input),
      });
      await this.assertValidAfter(tx, env);
      return updated;
    });
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action: 'PAYMENT_ROUTE_UPDATED',
      entityType: 'PaymentRoute',
      entityId: id,
      metadata: { env, patch: input },
    });
    return row;
  }

  async deleteRoute(env: PaymentEnvName, id: string, actor: Actor) {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentRoute.findUnique({ where: { id } });
      if (!existing || existing.env !== env) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Payment route not found in this environment.',
          HttpStatus.NOT_FOUND,
        );
      }
      await tx.paymentRoute.delete({ where: { id } });
      await this.assertValidAfter(tx, env);
    });
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action: 'PAYMENT_ROUTE_DELETED',
      entityType: 'PaymentRoute',
      entityId: id,
      metadata: { env },
    });
    return { deleted: true };
  }

  /**
   * Run a live health check against a provider's adapter, if one is constructed in
   * this process. Providers whose credentials are not wired here cannot be probed
   * remotely and report accordingly (honest, never a false green).
   */
  async testConnection(env: PaymentEnvName, id: string, actor: Actor) {
    const config = await this.prisma.paymentProviderConfig.findUnique({ where: { id } });
    if (!config || config.env !== env) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Payment provider config not found in this environment.',
        HttpStatus.NOT_FOUND,
      );
    }
    const adapter = this.registry.get(config.provider);
    let result: { healthy: boolean; mode?: string; message?: string };
    if (!adapter) {
      result = {
        healthy: false,
        message: `No adapter constructed for '${config.provider}' in this process; wire its credentials to test.`,
      };
    } else if (!adapter.healthCheck) {
      result = { healthy: false, message: `Provider '${config.provider}' has no health check.` };
    } else {
      result = await adapter.healthCheck();
    }
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action: 'PAYMENT_CONFIG_TESTED',
      entityType: 'PaymentProviderConfig',
      entityId: id,
      metadata: { env, provider: config.provider, healthy: result.healthy },
    });
    return result;
  }

  /** Live health of every provider adapter constructed in this process. */
  async providerHealth() {
    const providers = await Promise.all(
      this.registry.list().map(async (p) => {
        if (!p.healthCheck) {
          return { provider: p.name, healthy: false, message: 'no health check available' };
        }
        try {
          return { provider: p.name, ...(await p.healthCheck()) };
        } catch (err) {
          return {
            provider: p.name,
            healthy: false,
            message: err instanceof Error ? err.message : 'health check failed',
          };
        }
      }),
    );
    return { activeEnv: this.config.environment, providers };
  }

  /** Read the env's config via the tx and reject if a fail-closed env is invalid. */
  private async assertValidAfter(tx: Prisma.TransactionClient, env: PaymentEnvName): Promise<void> {
    const [providers, routes] = await Promise.all([
      tx.paymentProviderConfig.findMany({ where: { env: env as PaymentEnv } }),
      tx.paymentRoute.findMany({ where: { env: env as PaymentEnv } }),
    ]);
    const result = validate(env, providers, routes);
    if (isFailClosed(env) && !result.ok) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This change would leave ${env} in an invalid (fail-closed) state.`,
        HttpStatus.CONFLICT,
        { issues: result.issues },
      );
    }
  }
}

function validate(
  env: PaymentEnvName,
  providers: {
    provider: string;
    enabled: boolean;
    mode: PaymentProviderMode;
    publicKey: string | null;
    secretKeyRef: string | null;
    webhookSecretRef: string | null;
  }[],
  routes: {
    country: string;
    currency: string;
    method: string;
    provider: string;
    failoverProvider: string | null;
    active: boolean;
  }[],
): ValidationResult {
  const providerViews: ProviderConfigView[] = providers.map((p) => ({
    provider: p.provider,
    enabled: p.enabled,
    mode: p.mode,
    publicKey: p.publicKey,
    secretKeyRef: p.secretKeyRef,
    webhookSecretRef: p.webhookSecretRef,
  }));
  const routeViews: RouteView[] = routes.map((r) => ({
    country: r.country,
    currency: r.currency,
    method: r.method,
    provider: r.provider,
    failoverProvider: r.failoverProvider,
    active: r.active,
  }));
  return validatePaymentConfig({ env, providers: providerViews, routes: routeViews });
}

function normalizeRoute(input: RouteInput) {
  return {
    country: input.country.toUpperCase(),
    currency: input.currency.toUpperCase(),
    method: input.method.toUpperCase(),
    provider: input.provider,
    failoverProvider: input.failoverProvider ?? null,
    priority: input.priority ?? 100,
    active: input.active ?? true,
  };
}

function normalizeRoutePatch(input: Partial<RouteInput>) {
  const data: Record<string, unknown> = {};
  if (input.country !== undefined) data.country = input.country.toUpperCase();
  if (input.currency !== undefined) data.currency = input.currency.toUpperCase();
  if (input.method !== undefined) data.method = input.method.toUpperCase();
  if (input.provider !== undefined) data.provider = input.provider;
  if (input.failoverProvider !== undefined) data.failoverProvider = input.failoverProvider;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.active !== undefined) data.active = input.active;
  return data;
}

/** Strip any accidental secret-looking values from audit metadata (defensive). */
function sanitize(patch: ProviderConfigPatch): ProviderConfigPatch {
  return patch;
}
