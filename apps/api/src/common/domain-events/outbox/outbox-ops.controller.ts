import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { OutboxStatus } from '@prisma/client';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../../decorators';
import { OutboxOpsService } from './outbox-ops.service';
import { OutboxHealthService } from './outbox-health.service';

/**
 * Admin-only outbox operations (ADR-041 §22). Guarded by the global RolesGuard; all
 * mutating actions are audited in the service. Responses expose safe metadata only.
 */
@ApiTags('admin:outbox')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.OPS_READ)
@Controller('admin/outbox')
export class OutboxOpsController {
  constructor(
    private readonly ops: OutboxOpsService,
    private readonly health: OutboxHealthService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Outbox dispatcher health + backlog.' })
  getHealth() {
    return this.health.report();
  }

  @Get('events')
  list(@Query('status') status: OutboxStatus, @Query('limit') limit?: string) {
    return this.ops.list(status, limit ? Number(limit) : undefined);
  }

  @Get('events/:id')
  inspect(@Param('id') id: string) {
    return this.ops.inspect(id);
  }

  @Get('aggregates/:type/:id/history')
  aggregateHistory(@Param('type') type: string, @Param('id') id: string) {
    return this.ops.aggregateHistory(type, id);
  }

  @Get('correlations/:correlationId')
  correlationChain(@Param('correlationId') correlationId: string) {
    return this.ops.correlationChain(correlationId);
  }

  /*
    Every write below replays, cancels or parks a domain event, which re-runs (or stops) the
    side effects its handlers own. They need OPS_EXECUTE; reading the outbox stays OPS_READ.
    Each used to inherit the class's OPS_READ.
  */
  @Post('events/:id/retry')
  @RequiresAdmin(AdminPermission.OPS_EXECUTE)
  retry(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.retry(user?.id ?? null, id);
  }

  @Post('retry-batch')
  @RequiresAdmin(AdminPermission.OPS_EXECUTE)
  retryBatch(
    @CurrentUser() user: RequestUser,
    @Query('status') status: OutboxStatus,
    @Query('limit') limit?: string,
  ) {
    return this.ops.retryBatch(user?.id ?? null, status, limit ? Number(limit) : undefined);
  }

  @Post('events/:id/cancel')
  @RequiresAdmin(AdminPermission.OPS_EXECUTE)
  cancel(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.cancel(user?.id ?? null, id);
  }

  @Post('events/:id/manual-review')
  @RequiresAdmin(AdminPermission.OPS_EXECUTE)
  markReview(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.markManualReview(user?.id ?? null, id);
  }

  @Post('recover-stale-leases')
  @RequiresAdmin(AdminPermission.OPS_EXECUTE)
  recoverStale(@CurrentUser() user: RequestUser, @Body() _body: unknown) {
    void _body;
    return this.ops.releaseStaleLeases(user?.id ?? null);
  }
}
