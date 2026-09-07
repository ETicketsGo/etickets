import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../../common/decorators';
import { NotificationOpsService } from './notification-ops.service';
import { SuppressionService } from './suppression.service';

/**
 * Notification delivery operations, for the support desk.
 *
 * ── WHY OPS_READ AND NOT A NEW PERMISSION ──────────────────────────────────────────
 * `OPS_READ` already means "see queue depth, outbox, sync health and other operational
 * internals", which is exactly what this is. Minting a permission per subsystem produces a
 * permission list nobody can reason about, and an admin who can already read the outbox can
 * already see far more than a masked email address.
 *
 * The two MUTATING actions are separated onto `PLATFORM_CONFIG`: a resend spends money and
 * lifting a suppression re-enables sending to an address a provider has told us is bad.
 * Neither belongs to a read-only role, and both are audited.
 */
@ApiTags('admin:notifications')
@ApiBearerAuth()
/*
  The class-level capability is the FLOOR, and admin-surface.spec.ts requires it directly above
  the route prefix: an admin controller added later with no gate silently restores "every admin
  can do everything" in the one place nobody looks.

  (That test scans source for the decorator, so prose here must not spell one out -- an earlier
  draft of this very comment named the route decorator and the test dutifully reported this
  file as ungated. It was right to.)

  `getAllAndOverride` reads the handler before the class, so the two mutating routes below
  raise the bar to PLATFORM_CONFIG rather than inheriting this.
*/
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.OPS_READ)
@Controller('admin/notifications')
export class NotificationOpsController {
  constructor(
    private readonly ops: NotificationOpsService,
    private readonly suppression: SuppressionService,
  ) {}

  @Get()
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({ summary: 'Search notifications by reference, type, channel, provider, status.' })
  search(
    @Query('reference') reference?: string,
    @Query('type') type?: string,
    @Query('channel') channel?: string,
    @Query('provider') provider?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.search({
      reference,
      type,
      channel,
      provider,
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('health')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({ summary: 'Per-provider delivery outcomes and failure rate.' })
  health(@Query('hours') hours?: string) {
    return this.ops.providerHealth(hours ? Number(hours) : undefined);
  }

  @Get('suppressions')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({ summary: 'Destinations currently blocked, with masked addresses.' })
  suppressions(
    @Query('channel') channel?: string,
    @Query('reason') reason?: string,
    @Query('limit') limit?: string,
  ) {
    return this.suppression.list({ channel, reason, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @RequiresAdmin(AdminPermission.OPS_READ)
  @ApiOperation({ summary: 'One notification and every delivery attempt made for it.' })
  inspect(@Param('id') id: string) {
    return this.ops.inspect(id);
  }

  @Post(':id/resend')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Deliberately send a notification again. Audited.' })
  resend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { force?: boolean } = {},
  ) {
    return this.ops.resend(user.id, id, { force: body?.force === true });
  }

  @Post('suppressions/:id/lift')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Unblock a destination. Audited; the record is kept, not deleted.' })
  lift(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.liftSuppression(user.id, id);
  }
}
