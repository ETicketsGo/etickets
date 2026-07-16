import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from '../audit/audit.service';
import { OpsService } from './ops.service';
import { MaintenanceService, type MaintenanceState } from './maintenance.service';

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(500).optional(),
});

/**
 * Internal operations console API. Admin-only; additive; read/manage only —
 * it changes no business logic. All routes require ADMIN/SUPER_ADMIN, and the
 * whole `/admin/*` tree is exempt from maintenance-mode gating so admins can
 * always operate and turn maintenance off.
 */
@ApiTags('ops')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin/ops')
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Overall system health (DB/Redis/queue/storage + uptime).' })
  health() {
    return this.ops.health();
  }

  @Get('queues')
  @ApiOperation({ summary: 'Job counts + repeatable schedules for the holds queue.' })
  queues() {
    return this.ops.queues();
  }

  @Get('queues/failed')
  @ApiOperation({ summary: 'List recent failed jobs on the holds queue.' })
  failedJobs(@Query('limit') limit?: string) {
    const parsed = limit != null ? Number(limit) : undefined;
    return this.ops.failedJobs(Number.isFinite(parsed) ? (parsed as number) : undefined);
  }

  @Post('queues/retry-failed')
  @ApiOperation({ summary: 'Retry all failed jobs (bounded). Returns the count retried.' })
  retryFailed() {
    return this.ops.retryFailed();
  }

  @Post('queues/jobs/:id/retry')
  @ApiOperation({ summary: 'Retry a single failed job by id.' })
  retryJob(@Param('id') id: string) {
    return this.ops.retryJob(id);
  }

  @Get('maintenance')
  @ApiOperation({ summary: 'Current maintenance-mode flag.' })
  getMaintenance(): Promise<MaintenanceState> {
    return this.maintenance.getState();
  }

  @Post('maintenance')
  @ApiOperation({ summary: 'Set the maintenance-mode flag (and optional message).' })
  async setMaintenance(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(maintenanceSchema)) body: MaintenanceState,
  ): Promise<MaintenanceState> {
    const state = await this.maintenance.setState(body);
    // High-impact global kill-switch — record who flipped it and when.
    await this.audit.record({
      actorUserId: user.id,
      action: 'MAINTENANCE_TOGGLED',
      entityType: 'Maintenance',
      metadata: { enabled: body.enabled, message: body.message ?? null },
    });
    return state;
  }

  @Get('flags')
  @ApiOperation({ summary: 'Resolved feature flags (env-based; read-only).' })
  flags() {
    return this.ops.flags();
  }
}
