import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentEnv } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { MaintenanceService } from '../../ops/maintenance.service';
import { resolvePaymentEnv, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentOrchestrator } from '../orchestration/payment-orchestrator.service';

interface Actor {
  userId?: string;
  ip?: string | null;
}

/**
 * Provider outage operations (ADR-030). Admin controls for degradation events:
 * suspend/resume a route, a country, or a provider; activate/roll back failover
 * (via the circuit breaker); and toggle maintenance mode. Every action is audited
 * and alerts operations. Failover of createPayment is safe because it happens
 * before any irreversible capture; refunds never fail over (provider affinity).
 */
@Injectable()
export class PaymentOutageService {
  private readonly env: PaymentEnvName;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orchestrator: PaymentOrchestrator,
    private readonly maintenance: MaintenanceService,
    config: ConfigService,
  ) {
    this.env = resolvePaymentEnv(config.get<string>('APP_ENV'));
  }

  /** Current outage posture: circuit states, suspended routes, disabled providers. */
  async status() {
    const [routes, configs, maintenance] = await Promise.all([
      this.prisma.paymentRoute.findMany({ where: { env: this.env as PaymentEnv } }),
      this.prisma.paymentProviderConfig.findMany({ where: { env: this.env as PaymentEnv } }),
      this.maintenance.getState().catch(() => ({ enabled: false })),
    ]);
    return {
      env: this.env,
      maintenance,
      circuits: this.orchestrator.circuitStates(),
      suspendedRoutes: routes.filter((r) => !r.active).length,
      activeRoutes: routes.filter((r) => r.active).length,
      disabledProviders: configs.filter((c) => !c.enabled).map((c) => c.provider),
      enabledProviders: configs.filter((c) => c.enabled).map((c) => c.provider),
    };
  }

  async setRouteSuspended(id: string, suspended: boolean, actor: Actor) {
    const row = await this.prisma.paymentRoute.update({
      where: { id },
      data: { active: !suspended },
    });
    await this.record(
      actor,
      suspended ? 'PAYMENT_ROUTE_SUSPENDED' : 'PAYMENT_ROUTE_RESUMED',
      id,
      {},
    );
    return row;
  }

  /** Suspend/resume every route for a country in the current environment. */
  async setCountrySuspended(country: string, suspended: boolean, actor: Actor) {
    const result = await this.prisma.paymentRoute.updateMany({
      where: { env: this.env as PaymentEnv, country: country.toUpperCase() },
      data: { active: !suspended },
    });
    await this.record(
      actor,
      suspended ? 'PAYMENT_COUNTRY_SUSPENDED' : 'PAYMENT_COUNTRY_RESUMED',
      country.toUpperCase(),
      { affected: result.count },
    );
    return { country: country.toUpperCase(), affected: result.count };
  }

  /** Suspend/resume a provider (disable/enable its config) in the current env. */
  async setProviderSuspended(provider: string, suspended: boolean, actor: Actor) {
    const name = provider.toLowerCase();
    await this.prisma.paymentProviderConfig.updateMany({
      where: { env: this.env as PaymentEnv, provider: name },
      data: { enabled: !suspended },
    });
    await this.record(
      actor,
      suspended ? 'PAYMENT_PROVIDER_SUSPENDED' : 'PAYMENT_PROVIDER_RESUMED',
      name,
      {},
    );
    return { provider: name, suspended };
  }

  async activateFailover(provider: string, actor: Actor) {
    await this.orchestrator.activateFailover(provider, actor);
    return { provider: provider.toLowerCase(), failover: 'activated' };
  }

  async rollbackFailover(provider: string, actor: Actor) {
    await this.orchestrator.rollbackFailover(provider, actor);
    return { provider: provider.toLowerCase(), failover: 'rolled_back' };
  }

  async setMaintenance(enabled: boolean, message: string | undefined, actor: Actor) {
    const state = await this.maintenance.setState({ enabled, message });
    await this.record(
      actor,
      enabled ? 'PAYMENT_MAINTENANCE_ON' : 'PAYMENT_MAINTENANCE_OFF',
      'maintenance',
      {
        message,
      },
    );
    return state;
  }

  private async record(
    actor: Actor,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action,
      entityType: 'PaymentOutage',
      entityId,
      metadata: { env: this.env, ...metadata },
    });
  }
}
