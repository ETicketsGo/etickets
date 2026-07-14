import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentProviderConfig } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AppException, ErrorCodes } from '../../../common/errors';
import { SECRET_MANAGER, type SecretManager } from '../../../secrets/secret-manager.interface';
import {
  isDummyAllowed,
  resolvePaymentEnv,
  type PaymentEnvName,
} from '../../configuration/payment-environment';
import { MockPaymentProvider } from '../mock-payment.provider';
import { PaymentProviderRegistry } from '../../orchestration/provider-registry';
import type { PaymentProvider } from '../payment-provider.interface';
import { makeConfigShim } from './config-shim';
import { validateCredentials } from './credential-validator';
import { isDummyProvider, providerBinding, type ProviderBinding } from './provider-binding';

interface CachedProvider {
  instance: PaymentProvider;
  fingerprint: string;
}

/**
 * PaymentProviderFactory (ADR-024) — the production-binding path:
 *   PaymentProviderConfig → MerchantAccount → secret references → SecretManager →
 *   validated credentials → provider instance → registered.
 *
 * It reads the env-scoped config, resolves secret references through the
 * SecretManager, validates the credentials (placeholder / test-vs-live / mode
 * agreement / fail-closed on missing secrets), and constructs the adapter by
 * feeding the resolved values through a ConfigService shim — so the working
 * adapters are reused unchanged. Instances are cached by a config fingerprint and
 * refreshed after secret rotation. Dummy is refused in STAGING/PRODUCTION. No
 * provider-specific credential logic lives outside the per-provider bindings.
 */
@Injectable()
export class PaymentProviderFactory implements OnModuleInit {
  private readonly logger = new Logger(PaymentProviderFactory.name);
  private readonly env: PaymentEnvName;
  private readonly allowLiveKeysInLowerEnv: boolean;
  private readonly warmupOnBoot: boolean;
  private readonly cache = new Map<string, CachedProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(SECRET_MANAGER) private readonly secrets: SecretManager,
    private readonly registry: PaymentProviderRegistry,
    private readonly mock: MockPaymentProvider,
  ) {
    this.env = resolvePaymentEnv(config.get<string>('APP_ENV'));
    this.allowLiveKeysInLowerEnv =
      config.get<string>('PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV') === 'true';
    this.warmupOnBoot = config.get<string>('PAYMENT_FACTORY_WARMUP') !== 'false';
  }

  /** Best-effort: construct + register enabled real providers for this env on boot. */
  async onModuleInit(): Promise<void> {
    if (!this.warmupOnBoot) return;
    let enabled: { provider: string }[];
    try {
      enabled = await this.prisma.paymentProviderConfig.findMany({
        where: { env: this.env, enabled: true },
        select: { provider: true },
      });
    } catch (err) {
      this.logger.warn(`Provider factory warmup skipped: ${safe(err)}`);
      return;
    }
    for (const { provider } of enabled) {
      if (isDummyProvider(provider)) continue;
      try {
        await this.getProvider(provider);
        this.logger.log(`Bound payment provider '${provider}' for ${this.env}.`);
      } catch (err) {
        // Never break boot — an unbound provider fails closed at readiness/routing.
        this.logger.warn(`Could not bind provider '${provider}' in ${this.env}: ${safe(err)}`);
      }
    }
  }

  /**
   * Return a ready provider instance for `providerName`, constructing it from
   * config + resolved secrets if not already cached under the same fingerprint.
   * Throws (fail closed) if the provider is disabled, misconfigured, or its
   * credentials are invalid.
   */
  async getProvider(providerName: string): Promise<PaymentProvider> {
    const name = providerName.toLowerCase();

    if (isDummyProvider(name)) {
      if (!isDummyAllowed(this.env)) {
        throw this.fail(`Dummy provider is not allowed in ${this.env}.`);
      }
      this.registry.add(this.mock);
      return this.mock;
    }

    const binding = providerBinding(name);
    if (!binding)
      throw this.fail(`Unknown payment provider '${providerName}'.`, HttpStatus.NOT_FOUND);

    const config = await this.loadConfig(name);
    const fingerprint = this.fingerprint(config);
    const cached = this.cache.get(name);
    if (cached && cached.fingerprint === fingerprint) return cached.instance;

    const instance = await this.build(binding, config);
    this.cache.set(name, { instance, fingerprint });
    this.registry.add(instance);
    return instance;
  }

  /** Invalidate cached secrets + instance and rebuild (secret rotation / config change). */
  async refresh(providerName: string): Promise<PaymentProvider> {
    const name = providerName.toLowerCase();
    const config = await this.prisma.paymentProviderConfig.findUnique({
      where: { env_provider: { env: this.env, provider: name } },
    });
    if (config?.secretKeyRef) this.secrets.invalidateCache(config.secretKeyRef);
    if (config?.webhookSecretRef) this.secrets.invalidateCache(config.webhookSecretRef);
    this.cache.delete(name);
    return this.getProvider(name);
  }

  private async loadConfig(name: string): Promise<PaymentProviderConfig> {
    const config = await this.prisma.paymentProviderConfig.findUnique({
      where: { env_provider: { env: this.env, provider: name } },
    });
    if (!config)
      throw this.fail(`Provider '${name}' is not configured in ${this.env}.`, HttpStatus.NOT_FOUND);
    if (!config.enabled) throw this.fail(`Provider '${name}' is not enabled in ${this.env}.`);
    return config;
  }

  private async build(
    binding: ProviderBinding,
    config: PaymentProviderConfig,
  ): Promise<PaymentProvider> {
    const secret = config.secretKeyRef
      ? await this.secrets.getSecret(config.secretKeyRef)
      : undefined;
    const webhookSecret = config.webhookSecretRef
      ? await this.secrets.getSecret(config.webhookSecretRef)
      : undefined;

    const classified = binding.classifyMode({
      publicKey: config.publicKey ?? undefined,
      secret,
      apiBaseUrl: config.apiBaseUrl ?? undefined,
    });

    const reasons = validateCredentials({
      env: this.env,
      mode: config.mode,
      classified,
      publicKey: config.publicKey ?? undefined,
      secret,
      webhookSecret,
      requiresSecret: Boolean(binding.secretKeyEnv),
      requiresWebhookSecret: Boolean(binding.webhookSecretEnv),
      allowLiveKeysInLowerEnv: this.allowLiveKeysInLowerEnv,
    });
    if (reasons.length > 0) {
      // Reasons are secret-free by construction.
      throw this.fail(
        `Cannot activate '${binding.provider}' in ${this.env}: ${reasons.join('; ')}.`,
      );
    }

    // Map resolved values → the exact env keys the adapter reads. Non-secret
    // operational vars come from the validated app config (zod defaults included).
    const values: Record<string, string | undefined> = {};
    for (const key of binding.passthroughEnv) values[key] = this.config.get<string>(key);
    if (binding.publicKeyEnv) values[binding.publicKeyEnv] = config.publicKey ?? undefined;
    if (binding.secretKeyEnv) values[binding.secretKeyEnv] = secret;
    if (binding.webhookSecretEnv) values[binding.webhookSecretEnv] = webhookSecret;
    if (binding.apiBaseUrlEnv) values[binding.apiBaseUrlEnv] = config.apiBaseUrl ?? undefined;

    return binding.construct(makeConfigShim(values));
  }

  private fingerprint(config: PaymentProviderConfig): string {
    return [
      config.mode,
      config.publicKey ?? '',
      config.secretKeyRef ?? '',
      config.webhookSecretRef ?? '',
      config.apiBaseUrl ?? '',
      config.updatedAt.toISOString(),
    ].join('|');
  }

  private fail(message: string, status: HttpStatus = HttpStatus.SERVICE_UNAVAILABLE): AppException {
    return new AppException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, message, status);
  }
}

function safe(err: unknown): string {
  return err instanceof Error ? err.message : 'error';
}
