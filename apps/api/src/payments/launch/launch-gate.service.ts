import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentEnv } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SECRET_MANAGER, type SecretManager } from '../../secrets/secret-manager.interface';
import { resolvePaymentEnv, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentLiveReadinessService } from '../readiness/payment-live-readiness.service';

export interface LaunchGateProvider {
  provider: string;
  goNoGo: 'GO' | 'NO-GO';
  ready: boolean;
  countries: string[];
  currencies: string[];
  activeMerchants: number;
  latestCertification: { result: string; at: string } | null;
  webhookVerified: boolean;
  failedChecks: string[];
}

export interface LaunchGateReport {
  env: PaymentEnvName;
  generatedAtNote: string;
  overall: 'GO' | 'NO-GO';
  secretManager: { provider: string; healthy: boolean };
  maintenanceOff: boolean;
  reconciliation: { openDiscrepancies: number; ready: boolean };
  countryProviderMatrix: {
    country: string;
    currency: string;
    method: string;
    provider: string;
    failoverProvider: string | null;
    active: boolean;
  }[];
  providers: LaunchGateProvider[];
  remainingRisks: string[];
}

/**
 * Final launch gate (ADR-031). Aggregates the readiness signals, matrices and
 * certification evidence into a single GO / NO-GO report per provider. A provider is
 * never GO unless a recent PASS certification exists AND every production safety
 * control passes (delegated to the readiness service). Never exposes secrets.
 */
@Injectable()
export class LaunchGateService {
  private readonly env: PaymentEnvName;

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: PaymentLiveReadinessService,
    @Inject(SECRET_MANAGER) private readonly secrets: SecretManager,
    config: ConfigService,
  ) {
    this.env = resolvePaymentEnv(config.get<string>('APP_ENV'));
  }

  async report(): Promise<LaunchGateReport> {
    const readiness = await this.readiness.evaluate();
    const [routes, configs, onboardings, certs, openDiscrepancies, smHealth] = await Promise.all([
      this.prisma.paymentRoute.findMany({ where: { env: this.env as PaymentEnv } }),
      this.prisma.paymentProviderConfig.findMany({ where: { env: this.env as PaymentEnv } }),
      this.prisma.merchantOnboarding.findMany({ where: { env: this.env as PaymentEnv } }),
      this.prisma.merchantCertification.findMany({
        where: { env: this.env as PaymentEnv },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.reconciliationDiscrepancy.count({
        where: { env: this.env as PaymentEnv, status: { in: ['OPEN', 'ASSIGNED'] } },
      }),
      this.secrets.healthCheck().catch(() => ({ healthy: false, provider: this.secrets.provider })),
    ]);

    const maintenanceOff =
      readiness.global.find((c) => c.key === 'maintenance-off')?.passed ?? false;
    const providerNames = new Set(configs.filter((c) => c.enabled).map((c) => c.provider));

    const providers: LaunchGateProvider[] = [];
    for (const name of providerNames) {
      const pr = readiness.providers.find((p) => p.provider === name);
      const providerRoutes = routes.filter(
        (r) => r.provider === name || r.failoverProvider === name,
      );
      const activeMerchants = onboardings.filter(
        (o) => o.provider === name && o.status === 'ACTIVE',
      );
      const latestCert = certs.find((c) => c.provider === name) ?? null;
      const ready = Boolean(pr?.ok) && readiness.global.every((c) => c.passed);
      providers.push({
        provider: name,
        goNoGo: ready ? 'GO' : 'NO-GO',
        ready,
        countries: [...new Set(providerRoutes.map((r) => r.country))],
        currencies: [...new Set(providerRoutes.map((r) => r.currency))],
        activeMerchants: activeMerchants.length,
        latestCertification: latestCert
          ? { result: latestCert.result, at: latestCert.createdAt.toISOString() }
          : null,
        webhookVerified: onboardings.some(
          (o) =>
            o.provider === name && o.status === 'ACTIVE' && o.webhookEndpointStatus === 'VERIFIED',
        ),
        failedChecks: (pr?.checks ?? []).filter((c) => !c.passed).map((c) => c.key),
      });
    }

    const risks = this.remainingRisks(providers, openDiscrepancies, smHealth.healthy);
    const overall: 'GO' | 'NO-GO' = providers.some((p) => p.goNoGo === 'GO') ? 'GO' : 'NO-GO';

    return {
      env: this.env,
      generatedAtNote: 'Point-in-time; re-run before any go-live decision.',
      overall,
      secretManager: {
        provider: smHealth.provider ?? this.secrets.provider,
        healthy: smHealth.healthy,
      },
      maintenanceOff,
      reconciliation: { openDiscrepancies, ready: openDiscrepancies === 0 },
      countryProviderMatrix: routes.map((r) => ({
        country: r.country,
        currency: r.currency,
        method: r.method,
        provider: r.provider,
        failoverProvider: r.failoverProvider,
        active: r.active,
      })),
      providers,
      remainingRisks: risks,
    };
  }

  private remainingRisks(
    providers: LaunchGateProvider[],
    openDiscrepancies: number,
    smHealthy: boolean,
  ): string[] {
    const risks: string[] = [];
    if (this.env !== 'PRODUCTION') {
      risks.push(`Current environment is ${this.env}, not PRODUCTION — no live customer payments.`);
    }
    if (!smHealthy) risks.push('Secret manager is not healthy.');
    if (openDiscrepancies > 0)
      risks.push(`${openDiscrepancies} open reconciliation discrepancies.`);
    for (const p of providers) {
      if (p.goNoGo === 'NO-GO') {
        risks.push(
          `${p.provider}: NO-GO — failing ${p.failedChecks.join(', ') || 'global checks'}.`,
        );
      }
      if (!p.latestCertification || p.latestCertification.result !== 'PASS') {
        risks.push(`${p.provider}: no recent PASS certification.`);
      }
    }
    if (providers.length === 0) risks.push('No enabled real provider in this environment.');
    return risks;
  }
}
