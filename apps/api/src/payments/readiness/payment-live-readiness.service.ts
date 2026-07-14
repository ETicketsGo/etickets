import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentEnv } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MaintenanceService } from '../../ops/maintenance.service';
import { SECRET_MANAGER, type SecretManager } from '../../secrets/secret-manager.interface';
import { resolvePaymentEnv, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import { isDummyProvider } from '../provider/factory/provider-binding';
import { PaymentOrchestrator } from '../orchestration/payment-orchestrator.service';

export interface ReadinessCheck {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
}
export interface ProviderReadiness {
  provider: string;
  ok: boolean;
  checks: ReadinessCheck[];
}
export interface LiveReadinessReport {
  env: PaymentEnvName;
  ok: boolean;
  global: ReadinessCheck[];
  providers: ProviderReadiness[];
}

/**
 * Payment-live readiness (ADR-028). Aggregates every production safety control into
 * a single report an operator can gate a launch on. It NEVER exposes secrets — only
 * booleans and safe, secret-free detail strings.
 */
@Injectable()
export class PaymentLiveReadinessService {
  private readonly env: PaymentEnvName;
  private readonly liveEnabled: boolean;
  private readonly certMaxAgeMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Inject(SECRET_MANAGER) private readonly secrets: SecretManager,
    private readonly factory: PaymentProviderFactory,
    private readonly orchestrator: PaymentOrchestrator,
    private readonly maintenance: MaintenanceService,
  ) {
    this.env = resolvePaymentEnv(config.get<string>('APP_ENV'));
    this.liveEnabled = config.get<string>('PAYMENT_LIVE_ENABLED') === 'true';
    this.certMaxAgeMs = (config.get<number>('CERTIFICATION_MAX_AGE_DAYS') ?? 30) * 86_400_000;
  }

  async evaluate(providerFilter?: string): Promise<LiveReadinessReport> {
    const [smHealth, maintenance] = await Promise.all([
      this.secrets.healthCheck().catch(() => ({ healthy: false })),
      this.maintenance.getState().catch(() => ({ enabled: false })),
    ]);

    const global: ReadinessCheck[] = [
      { key: 'live-enabled', label: 'PAYMENT_LIVE_ENABLED is true', passed: this.liveEnabled },
      {
        key: 'env-production',
        label: 'Environment is PRODUCTION',
        passed: this.env === 'PRODUCTION',
      },
      { key: 'secret-manager', label: 'Secret manager healthy', passed: smHealth.healthy },
      { key: 'maintenance-off', label: 'Maintenance mode is off', passed: !maintenance.enabled },
    ];

    const configs = await this.prisma.paymentProviderConfig.findMany({
      where: {
        env: this.env as PaymentEnv,
        enabled: true,
        ...(providerFilter ? { provider: providerFilter.toLowerCase() } : {}),
      },
    });

    const providers: ProviderReadiness[] = [];
    for (const config of configs) {
      if (isDummyProvider(config.provider)) {
        providers.push({
          provider: config.provider,
          ok: false,
          checks: [{ key: 'not-dummy', label: 'Not the dummy provider', passed: false }],
        });
        continue;
      }
      providers.push(await this.evaluateProvider(config));
    }

    const globalOk = global.every((c) => c.passed);
    const providersOk = providers.length > 0 && providers.every((p) => p.ok);
    return { env: this.env, ok: globalOk && providersOk, global, providers };
  }

  private async evaluateProvider(config: {
    provider: string;
    mode: string;
  }): Promise<ProviderReadiness> {
    const name = config.provider;
    const checks: ReadinessCheck[] = [];

    checks.push({ key: 'not-dummy', label: 'Not the dummy provider', passed: true });
    checks.push({
      key: 'mode-live',
      label: 'Provider mode is LIVE',
      passed: config.mode === 'LIVE',
    });

    // Build the live instance — succeeds only with valid, non-placeholder, non-test
    // credentials (the factory validates). A throw becomes a failed check (secret-free).
    let healthPassing = false;
    let credsValid = false;
    try {
      const instance = await this.factory.getProvider(name);
      credsValid = true;
      healthPassing = instance.healthCheck ? (await instance.healthCheck()).healthy : false;
    } catch (err) {
      checks.push({
        key: 'credentials',
        label: 'Credentials valid (live, non-placeholder)',
        passed: false,
        detail: err instanceof Error ? err.message : 'could not build provider',
      });
    }
    if (credsValid) {
      checks.push({
        key: 'credentials',
        label: 'Credentials valid (live, non-placeholder)',
        passed: true,
      });
    }
    checks.push({ key: 'health', label: 'Provider health passing', passed: healthPassing });

    const [activeMerchant, verifiedWebhook, cert, routeCount] = await Promise.all([
      this.prisma.merchantOnboarding.findFirst({
        where: { env: this.env as PaymentEnv, provider: name, status: 'ACTIVE' },
      }),
      this.prisma.merchantOnboarding.findFirst({
        where: {
          env: this.env as PaymentEnv,
          provider: name,
          status: 'ACTIVE',
          webhookEndpointStatus: 'VERIFIED',
        },
      }),
      this.prisma.merchantCertification.findFirst({
        where: { env: this.env as PaymentEnv, provider: name, result: 'PASS' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.paymentRoute.count({
        where: {
          env: this.env as PaymentEnv,
          active: true,
          OR: [{ provider: name }, { failoverProvider: name }],
        },
      }),
    ]);

    const certRecent =
      !!cert && Date.now() - new Date(cert.createdAt).getTime() <= this.certMaxAgeMs;

    checks.push({
      key: 'merchant-active',
      label: 'An ACTIVE merchant exists',
      passed: !!activeMerchant,
    });
    checks.push({
      key: 'webhook-verified',
      label: 'Webhook endpoint verified',
      passed: !!verifiedWebhook,
    });
    checks.push({ key: 'certification', label: 'Recent PASS certification', passed: certRecent });
    checks.push({ key: 'route', label: 'Currency/country route matches', passed: routeCount > 0 });
    checks.push({
      key: 'circuit',
      label: 'Circuit breaker not open',
      passed: !this.orchestrator.isCircuitOpen(name),
    });

    return { provider: name, ok: checks.every((c) => c.passed), checks };
  }
}
