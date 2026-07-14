import { Body, Controller, Delete, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PAYMENT_ENVS, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentConfigService } from '../configuration/payment-config.service';
import { PaymentReconciliationService } from '../reconciliation/payment-reconciliation.service';
import { PaymentLiveReadinessService } from '../readiness/payment-live-readiness.service';
import { LaunchGateService } from '../launch/launch-gate.service';
import {
  PaymentAdminService,
  type ProviderConfigPatch,
  type RouteInput,
} from './payment-admin.service';

/** Parse an optional ISO date, or fall back. */
function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const envSchema = z.enum(PAYMENT_ENVS);

const configPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['DUMMY', 'TEST', 'LIVE']).optional(),
    publicKey: z.string().nullable().optional(),
    secretKeyRef: z.string().nullable().optional(),
    webhookSecretRef: z.string().nullable().optional(),
    apiBaseUrl: z.string().nullable().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(0).optional(),
    retryBackoffMs: z.number().int().min(0).optional(),
    circuitFailureThreshold: z.number().int().positive().optional(),
    circuitCooldownMs: z.number().int().min(0).optional(),
    priority: z.number().int().optional(),
  })
  .strict();

const routeSchema = z
  .object({
    country: z.string().min(1).default('*'),
    currency: z.string().min(1).default('*'),
    method: z.string().min(1).default('*'),
    provider: z.string().min(1),
    failoverProvider: z.string().nullable().optional(),
    priority: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const routePatchSchema = routeSchema.partial();

/**
 * Admin console for runtime payment configuration (ADR-022). All routes require an
 * ADMIN/SUPER_ADMIN role. Mutations are validated fail-closed and audited by the
 * service. The `env` query param selects the target environment (default: active).
 */
@ApiTags('admin-payments')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin/payments')
export class PaymentAdminController {
  constructor(
    private readonly admin: PaymentAdminService,
    private readonly config: PaymentConfigService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly readiness: PaymentLiveReadinessService,
    private readonly launchGate: LaunchGateService,
  ) {}

  private resolveEnv(raw?: string): PaymentEnvName {
    if (!raw) return this.config.environment;
    return envSchema.parse(raw.toUpperCase());
  }

  @Get('config')
  @ApiOperation({ summary: 'Payment configuration overview for an environment (admin).' })
  overview(@Query('env') env?: string) {
    return this.admin.overview(this.resolveEnv(env));
  }

  @Get('health')
  @ApiOperation({ summary: 'Live health of constructed payment provider adapters (admin).' })
  health() {
    return this.admin.providerHealth();
  }

  @Get('live-readiness')
  @ApiOperation({ summary: 'Payment-live readiness checklist (production safety) (admin).' })
  liveReadiness(@Query('provider') provider?: string) {
    return this.readiness.evaluate(provider);
  }

  @Get('launch-gate')
  @ApiOperation({ summary: 'Final launch gate: matrices + GO/NO-GO by provider (admin).' })
  launchGateReport() {
    return this.launchGate.report();
  }

  @Get('reconciliation')
  @ApiOperation({ summary: 'Reconcile our payments against provider truth for a window (admin).' })
  reconcile(@Query('from') from?: string, @Query('to') to?: string) {
    const toDate = parseDate(to, new Date());
    const fromDate = parseDate(from, new Date(toDate.getTime() - 7 * 24 * 3600 * 1000));
    return this.reconciliation.reconcile(fromDate, toDate);
  }

  @Get('settlement')
  @ApiOperation({ summary: 'Settlement summary per provider + currency for a window (admin).' })
  settlement(@Query('from') from?: string, @Query('to') to?: string) {
    const toDate = parseDate(to, new Date());
    const fromDate = parseDate(from, new Date(toDate.getTime() - 30 * 24 * 3600 * 1000));
    return this.reconciliation.settlement(fromDate, toDate);
  }

  @Patch('config/:id')
  @ApiOperation({ summary: 'Update a payment provider config (admin).' })
  updateConfig(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(configPatchSchema)) patch: ProviderConfigPatch,
    @Query('env') env?: string,
  ) {
    return this.admin.updateConfig(this.resolveEnv(env), id, patch, { userId: user.id, ip });
  }

  @Post('config/:id/test-connection')
  @ApiOperation({ summary: 'Run a live health check against a provider (admin).' })
  testConnection(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Query('env') env?: string,
  ) {
    return this.admin.testConnection(this.resolveEnv(env), id, { userId: user.id, ip });
  }

  @Post('routes')
  @ApiOperation({ summary: 'Create a payment route (admin).' })
  createRoute(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Body(new ZodValidationPipe(routeSchema)) input: RouteInput,
    @Query('env') env?: string,
  ) {
    return this.admin.createRoute(this.resolveEnv(env), input, { userId: user.id, ip });
  }

  @Patch('routes/:id')
  @ApiOperation({ summary: 'Update a payment route (admin).' })
  updateRoute(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(routePatchSchema)) input: Partial<RouteInput>,
    @Query('env') env?: string,
  ) {
    return this.admin.updateRoute(this.resolveEnv(env), id, input, { userId: user.id, ip });
  }

  @Delete('routes/:id')
  @ApiOperation({ summary: 'Delete a payment route (admin).' })
  deleteRoute(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Query('env') env?: string,
  ) {
    return this.admin.deleteRoute(this.resolveEnv(env), id, { userId: user.id, ip });
  }
}
