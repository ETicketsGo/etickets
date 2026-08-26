import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { SyncOpsService } from './sync-ops.service';

/**
 * Admin-only operational surface for the inventory sync platform (ADR-040 §22).
 * Guarded by the global RolesGuard (@Roles ADMIN); every mutating action is audited in
 * the service. Responses never include secrets or raw provider payloads.
 */
@ApiTags('admin:inventory-sync')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.OPS_READ)
@Controller('admin/inventory-sync')
export class SyncOpsController {
  constructor(private readonly ops: SyncOpsService) {}

  @Post('events/:id/reprocess')
  @ApiOperation({ summary: 'Requeue a raw provider event for reprocessing.' })
  reprocess(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.reprocess(user?.id ?? null, id);
  }

  @Post('events/:id/manual-review')
  markReview(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.markManualReview(user?.id ?? null, id);
  }

  @Post('providers/:providerCode/retry-failed')
  retryFailed(
    @CurrentUser() user: RequestUser,
    @Param('providerCode') providerCode: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.retryFailed(user?.id ?? null, providerCode, limit ? Number(limit) : undefined);
  }

  @Post('providers/:providerCode/reconcile')
  reconcile(@Param('providerCode') providerCode: string, @Query('limit') limit?: string) {
    return this.ops.runReconciliation(providerCode, limit ? Number(limit) : undefined);
  }

  @Get('providers/:providerCode/health')
  health(@Param('providerCode') providerCode: string) {
    return this.ops.providerHealth(providerCode);
  }

  @Post('mappings/:id/resolve')
  resolveMapping(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { internalEntityType: string; internalEntityId: string },
  ) {
    return this.ops.resolveMapping(
      user?.id ?? null,
      id,
      body.internalEntityType,
      body.internalEntityId,
    );
  }

  @Post('providers/:providerCode/checkpoint/reset')
  resetCheckpoint(
    @CurrentUser() user: RequestUser,
    @Param('providerCode') providerCode: string,
    @Body() body: { providerTenantId?: string; resource: string },
  ) {
    return this.ops.resetCheckpoint(
      user?.id ?? null,
      providerCode,
      body.providerTenantId ?? '',
      body.resource,
    );
  }
}
