import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PaymentEnv,
  PaymentProviderConfig,
  MerchantAccount,
  PaymentRoute,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { isFailClosed, resolvePaymentEnv, type PaymentEnvName } from './payment-environment';
import { selectMerchant, selectRoute, type MerchantRow, type RouteRow } from './payment-routing';
import {
  validatePaymentConfig,
  type ProviderConfigView,
  type RouteView,
  type ValidationResult,
} from './payment-config.validator';

/** Context the booking/orchestration layer supplies to resolve a provider. */
export interface PaymentContext {
  country?: string; // ISO-3166 alpha-2 (optional; falls back to wildcard routes)
  currency: string; // ISO-4217
  method?: string; // PaymentMethod
}

/** A single resolved provider target (primary or failover). */
export interface ResolvedProviderTarget {
  provider: string;
  mode: PaymentProviderConfig['mode'];
  publicKey?: string;
  secretKeyRef?: string;
  webhookSecretRef?: string;
  apiBaseUrl?: string;
  merchant?: { label: string; merchantIdRef?: string };
  ops: {
    timeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
    circuitFailureThreshold: number;
    circuitCooldownMs: number;
  };
}

export interface ResolvedPaymentTarget {
  env: PaymentEnvName;
  country: string;
  currency: string;
  method: string;
  primary: ResolvedProviderTarget;
  failover?: ResolvedProviderTarget;
}

type ConfigWithMerchants = PaymentProviderConfig & { merchantAccounts: MerchantAccount[] };

/**
 * Reads env-scoped runtime payment configuration (ADR-020) and resolves the
 * provider chain for a payment: routing policy → provider config → merchant
 * account. Runs the fail-closed validator on boot so a misconfigured production
 * refuses to start. Holds NO secrets — only public identifiers + secret references.
 */
@Injectable()
export class PaymentConfigService implements OnModuleInit {
  private readonly logger = new Logger(PaymentConfigService.name);
  private readonly env: PaymentEnvName;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.env = resolvePaymentEnv(config.get<string>('APP_ENV'));
  }

  /** The active deployment environment. */
  get environment(): PaymentEnvName {
    return this.env;
  }

  /**
   * Validate on boot. Fail-closed environments (staging/production) refuse to start
   * when configuration is invalid; lower environments only log warnings so local
   * and CI (empty config, dummy default) boot unchanged.
   */
  async onModuleInit(): Promise<void> {
    let result: ValidationResult;
    try {
      result = await this.validate();
    } catch (err) {
      // A DB failure at boot is itself invalid config for a fail-closed env.
      const message = err instanceof Error ? err.message : 'unknown error';
      if (isFailClosed(this.env)) {
        throw new AppException(
          ErrorCodes.INTERNAL,
          `Payment configuration could not be validated in ${this.env}: ${message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      this.logger.warn(`Payment config validation skipped in ${this.env}: ${message}`);
      return;
    }

    for (const issue of result.issues) {
      const line = `[payments:${this.env}] ${issue.severity} ${issue.provider ? `(${issue.provider}) ` : ''}${issue.message}`;
      if (issue.severity === 'ERROR') this.logger.error(line);
      else this.logger.warn(line);
    }

    if (!result.ok && isFailClosed(this.env)) {
      throw new AppException(
        ErrorCodes.INTERNAL,
        `Payment configuration is invalid in ${this.env}; refusing to start (fail closed).`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /** Load + validate the current environment's payment configuration. */
  async validate(): Promise<ValidationResult> {
    const [configs, routes] = await Promise.all([
      this.prisma.paymentProviderConfig.findMany({ where: { env: this.env } }),
      this.prisma.paymentRoute.findMany({ where: { env: this.env } }),
    ]);
    const providerViews: ProviderConfigView[] = configs.map((c) => ({
      provider: c.provider,
      enabled: c.enabled,
      mode: c.mode,
      publicKey: c.publicKey,
      secretKeyRef: c.secretKeyRef,
      webhookSecretRef: c.webhookSecretRef,
    }));
    const routeViews: RouteView[] = routes.map(toRouteView);
    return validatePaymentConfig({ env: this.env, providers: providerViews, routes: routeViews });
  }

  /**
   * Resolve the provider chain (primary + optional failover) for a payment. Throws
   * a fail-closed error when no route matches or the routed provider is not enabled.
   */
  async resolveTarget(context: PaymentContext): Promise<ResolvedPaymentTarget> {
    const routes = await this.prisma.paymentRoute.findMany({
      where: { env: this.env, active: true },
    });
    const decision = selectRoute(routes.map(toRouteRow), context);
    if (!decision) {
      throw this.failClosed(
        `No payment route configured for ${context.country ?? '*'}/${context.currency} in ${this.env}.`,
      );
    }

    const primary = await this.loadTarget(decision.provider, context);
    if (!primary) {
      throw this.failClosed(
        `Routed provider '${decision.provider}' is not enabled in ${this.env}.`,
      );
    }
    const failover = decision.failoverProvider
      ? ((await this.loadTarget(decision.failoverProvider, context)) ?? undefined)
      : undefined;

    return {
      env: this.env,
      country: (context.country ?? '*').toUpperCase(),
      currency: context.currency.toUpperCase(),
      method: (context.method ?? '*').toUpperCase(),
      primary,
      failover,
    };
  }

  /** Load one enabled provider config + its best merchant account, as a target. */
  private async loadTarget(
    provider: string,
    context: PaymentContext,
  ): Promise<ResolvedProviderTarget | null> {
    const config = (await this.prisma.paymentProviderConfig.findUnique({
      where: { env_provider: { env: this.env, provider } },
      include: { merchantAccounts: true },
    })) as ConfigWithMerchants | null;
    if (!config || !config.enabled) return null;

    const merchant = selectMerchant(
      config.merchantAccounts.map(toMerchantRow),
      context.country,
      context.currency,
    );

    return {
      provider: config.provider,
      mode: config.mode,
      publicKey: config.publicKey ?? undefined,
      secretKeyRef: config.secretKeyRef ?? undefined,
      webhookSecretRef: config.webhookSecretRef ?? undefined,
      apiBaseUrl: config.apiBaseUrl ?? undefined,
      merchant: merchant
        ? { label: merchant.label, merchantIdRef: merchant.merchantIdRef ?? undefined }
        : undefined,
      ops: {
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        retryBackoffMs: config.retryBackoffMs,
        circuitFailureThreshold: config.circuitFailureThreshold,
        circuitCooldownMs: config.circuitCooldownMs,
      },
    };
  }

  private failClosed(message: string): AppException {
    return new AppException(
      ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
      message,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

function toRouteRow(r: PaymentRoute): RouteRow {
  return {
    country: r.country,
    currency: r.currency,
    method: r.method,
    provider: r.provider,
    failoverProvider: r.failoverProvider,
    priority: r.priority,
  };
}

function toRouteView(r: PaymentRoute): RouteView {
  return {
    country: r.country,
    currency: r.currency,
    method: r.method,
    provider: r.provider,
    failoverProvider: r.failoverProvider,
    active: r.active,
  };
}

function toMerchantRow(m: MerchantAccount): MerchantRow {
  return {
    label: m.label,
    country: m.country,
    currency: m.currency,
    merchantIdRef: m.merchantIdRef,
    active: m.active,
  };
}

// Re-exported for consumers that only need the enum type.
export type { PaymentEnv };
