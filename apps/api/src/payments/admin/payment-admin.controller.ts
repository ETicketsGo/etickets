import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AppException, ErrorCodes } from '../../common/errors';
import { PAYMENT_ENVS, type PaymentEnvName } from '../configuration/payment-environment';
import { PaymentConfigService } from '../configuration/payment-config.service';
import { PaymentReconciliationService } from '../reconciliation/payment-reconciliation.service';
import { PaymentLiveReadinessService } from '../readiness/payment-live-readiness.service';
import { LaunchGateService } from '../launch/launch-gate.service';
import { TransferReconciliationService } from '../settlement/transfer-reconciliation.service';
import { FINDING_RESOLUTIONS } from '../settlement/finding-resolution';
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
 * What an operator must supply to close a money exception.
 *
 * The reason is mandatory and the evidence reference is conditionally mandatory; the conditional
 * part lives in `checkResolution` rather than here, because it is a policy worth reading on its
 * own rather than a validation detail buried in a controller.
 */
const resolveFindingSchema = z.object({
  resolution: z.enum(FINDING_RESOLUTIONS),
  note: z.string().min(1).max(1000),
  evidenceRef: z.string().max(200).optional(),
});

/**
 * Admin console for runtime payment configuration (ADR-022). All routes require an
 * ADMIN/SUPER_ADMIN role. Mutations are validated fail-closed and audited by the
 * service. The `env` query param selects the target environment (default: active).
 */
@ApiTags('admin-payments')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYMENT_ADMIN)
@Controller('admin/payments')
export class PaymentAdminController {
  constructor(
    private readonly admin: PaymentAdminService,
    private readonly config: PaymentConfigService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly readiness: PaymentLiveReadinessService,
    private readonly launchGate: LaunchGateService,
    private readonly transfers: TransferReconciliationService,
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

  /**
   * Record that an authorized person has dispositioned a money exception.
   *
   * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
   * It does not send, refund or reverse money, and it does not alter an entitlement, a released
   * amount or a transferred amount. Resolving says a person has DECIDED how to treat this
   * exception; correcting the ledger is a separate act with its own authority. The service that
   * performs it has no provider and no settlement service, so this is structural rather than a
   * promise.
   *
   * Authorization is the controller\'s: ADMIN or SUPER_ADMIN, plus PAYMENT_ADMIN. An organizer
   * cannot reach it, and nothing here grants resolution to someone who can merely read Finance.
   */
  @Post('reconciliation-findings/:id/resolve')
  @ApiOperation({ summary: 'Disposition a reconciliation finding (admin). Moves no money.' })
  async resolveFinding(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resolveFindingSchema))
    body: { resolution: (typeof FINDING_RESOLUTIONS)[number]; note: string; evidenceRef?: string },
  ) {
    const out = await this.transfers.resolveFinding(user, id, body);
    if (!out.resolved) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        out.reason ?? 'Could not resolve.',
        HttpStatus.CONFLICT,
      );
    }
    return { resolved: true };
  }

  /**
   * Ask the provider again about one unresolved transfer.
   *
   * OBSERVATION ONLY. It queries evidence and records what came back; it cannot create a
   * transfer, a reversal or a refund, because the reconciliation service is never handed
   * anything that can. Where no adapter implements a status query - which is every adapter today
   * - the honest result is a CANNOT_BE_ASKED finding rather than a retry.
   */
  @Post('unresolved-money/:attemptId/recheck')
  @ApiOperation({ summary: 'Re-observe one unresolved transfer (admin). Moves no money.' })
  recheck(@Param('attemptId') attemptId: string) {
    return this.transfers.recheckAttempt(attemptId);
  }

  /**
   * Money nobody can currently account for.
   *
   * ── READ-ONLY, DELIBERATELY ───────────────────────────────────────────────
   * There is no "mark paid", no "force success", no "retry transfer" and no "resolve". Every one
   * of those is a financial decision, and who is allowed to declare money correct is a product
   * question this repository has not answered. Visibility is worth more than a premature button,
   * and a button that silently fixed a disagreement would destroy the evidence it was ever there.
   *
   * It also makes no provider calls, so opening the screen cannot turn into dozens of outbound
   * requests about money.
   *
   * Authorization is the controller\'s: ADMIN or SUPER_ADMIN, plus PAYMENT_ADMIN. An organizer
   * cannot reach it, and `organizationId` narrows an admin\'s view rather than granting one.
   */
  @Get('unresolved-money')
  @ApiOperation({
    summary: 'Transfers with no known outcome, open reconciliation findings, and blocked payouts.',
  })
  unresolvedMoney(
    @Query('organizationId') organizationId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.transfers.operatorQueue({
      organizationId: organizationId?.trim() || undefined,
      limit: Number.isFinite(parsed) ? parsed : undefined,
    });
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
