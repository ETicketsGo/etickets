import { Body, Controller, Get, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { z } from 'zod';
import {
  RequiresAdmin,
  CurrentUser,
  Public,
  Roles,
  type RequestUser,
} from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CompensationAdminService, type AdminScope } from './compensation-admin.service';
import { CompensationHealthService } from './compensation-health.service';
import type { CompensationContext } from './compensation-planner';

const dryRunSchema = z
  .object({
    bookingId: z.string(),
    reasonCode: z.string().default('DRY_RUN'),
    redisLockPresent: z.boolean().optional(),
    localHoldActive: z.boolean().optional(),
    paymentSucceeded: z.boolean().optional(),
    providerOutcome: z
      .enum(['CONFIRMED', 'REJECTED', 'SOLD_OUT', 'AMBIGUOUS', 'EXPIRED'])
      .optional(),
    paymentCreatePermanentlyFailed: z.boolean().optional(),
    localConfirmationFailed: z.boolean().optional(),
    localConfirmationRetriesExhausted: z.boolean().optional(),
    redisFinalizeFailed: z.boolean().optional(),
    captureFailed: z.boolean().optional(),
    ticketIssuanceFailed: z.boolean().optional(),
    duplicateCallback: z.boolean().optional(),
    providerReservationId: z.string().optional(),
    providerBookingId: z.string().optional(),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().min(1).max(200) }).strict();

/**
 * RBAC-protected, audited compensation admin operations (ADR-043 §25, P5.3A). Platform ADMIN /
 * SUPER_ADMIN only (enforced by the global RolesGuard — this route is NEVER public). Every
 * operation is tenant-isolated and strictly non-financial: no refund/void/confirmed-cancel
 * execution, and no editing of amount/type/references/booking binding.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.FINANCE_READ)
@Controller('admin/compensations')
export class CompensationAdminController {
  constructor(private readonly admin: CompensationAdminService) {}

  private scope(user: RequestUser, tenantId: string | undefined, ip: string): AdminScope {
    return {
      actorUserId: user.id,
      isSuperAdmin: user.roles.includes(Role.SUPER_ADMIN as never),
      tenantId,
      ip,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List compensation records (tenant-scoped).' })
  list(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Query('tenantId') tenantId?: string,
    @Query('state') state?: string,
    @Query('bookingId') bookingId?: string,
  ) {
    return this.admin.list(this.scope(user, tenantId, ip), { state, bookingId });
  }

  @Get('booking/:bookingId/history')
  @ApiOperation({ summary: 'Compensation history + correlation chain for a booking.' })
  history(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('bookingId') bookingId: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.history(this.scope(user, tenantId, ip), bookingId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Inspect one compensation record (safe metadata).' })
  inspect(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.inspect(this.scope(user, tenantId, ip), id);
  }

  @Post('dry-run')
  @ApiOperation({ summary: 'Dry-run the compensation planner (read-only, no persistence).' })
  dryRun(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Body(new ZodValidationPipe(dryRunSchema)) body: CompensationContext,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.dryRun(this.scope(user, tenantId, ip), body);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a SAFE non-financial compensation → READY.' })
  approve(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.approve(this.scope(user, tenantId, ip), id);
  }

  @Post(':id/retry')
  @ApiOperation({ summary: 'Retry a SAFE non-financial compensation.' })
  retry(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.retry(this.scope(user, tenantId, ip), id);
  }

  @Post(':id/manual-review')
  @ApiOperation({ summary: 'Move a compensation to manual review.' })
  manualReview(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.markManualReview(this.scope(user, tenantId, ip), id, body.reason);
  }

  @Post(':id/release-lease')
  @ApiOperation({ summary: 'Release a stale/held lease on a processing compensation.' })
  releaseLease(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.admin.releaseLease(this.scope(user, tenantId, ip), id);
  }
}

/**
 * Read-only compensation health (ADR-043 §26). Counts only — no ids or PII — so it is safe as a
 * public operational probe, consistent with the other /health endpoints.
 */
@ApiTags('health')
@Controller('health')
export class CompensationHealthController {
  constructor(private readonly health: CompensationHealthService) {}

  @Public()
  @Get('compensation')
  @ApiOperation({ summary: 'Compensation backlog + recovery health (counts only).' })
  status() {
    return this.health.snapshot();
  }
}
