import { Body, Controller, Get, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { QueuedCheckIn } from '@eticketsgo/shared-types';
import { OfflineManifestService } from './offline-manifest.service';
import { CheckInDeviceService, type RegisterDeviceInput } from './checkin-device.service';
import { OfflineReconciliationService } from './offline-reconciliation.service';
import { OfflineCheckinReadinessService } from './offline-readiness.service';
import { OfflineDrillService, type RecordDrillInput } from './offline-drill.service';
import { OfflineActivationService, type RecordActivationInput } from './offline-activation.service';
import {
  OfflineReconciliationConsoleService,
  type ReconciliationFilters,
} from './offline-reconciliation-console.service';
import {
  OfflineCommandCenterService,
  type AcknowledgeAlertInput,
} from './offline-command-center.service';
import { OfflinePreflightService, type PreflightInput } from './offline-preflight.service';
import type { ReconcileResolutionAction } from '@eticketsgo/shared-types';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { AppException, ErrorCodes } from '../../common/errors';

/**
 * Offline gate check-in API (ADR-035). Operational endpoints 404 while the feature
 * flag is OFF (invisible); the readiness endpoint always answers (NO_GO when off).
 */
@ApiTags('offline-checkin')
@ApiBearerAuth()
@Controller('checkin')
export class OfflineCheckinController {
  constructor(
    private readonly manifest: OfflineManifestService,
    private readonly devices: CheckInDeviceService,
    private readonly reconciliation: OfflineReconciliationService,
    private readonly readiness: OfflineCheckinReadinessService,
    private readonly drills: OfflineDrillService,
    private readonly activations: OfflineActivationService,
    private readonly reconciliationConsole: OfflineReconciliationConsoleService,
    private readonly commandCenter: OfflineCommandCenterService,
    private readonly preflight: OfflinePreflightService,
  ) {}

  private assertEnabled() {
    if (!this.readiness.isEnabled()) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Not found.', HttpStatus.NOT_FOUND);
    }
  }

  @Post('devices')
  @ApiOperation({ summary: 'Register a check-in device (PENDING until approved).' })
  register(@CurrentUser() user: RequestUser, @Body() body: RegisterDeviceInput) {
    this.assertEnabled();
    return this.devices.register(user, body);
  }

  @Post('devices/:id/approve')
  @ApiOperation({ summary: 'Approve a registered device (manager).' })
  approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    this.assertEnabled();
    return this.devices.approve(user, id);
  }

  @Post('devices/:id/suspend')
  @ApiOperation({ summary: 'Suspend a device (reversible via approve).' })
  suspend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.assertEnabled();
    return this.devices.suspend(user, id, body?.reason);
  }

  @Post('devices/:id/revoke')
  @ApiOperation({ summary: 'Revoke a device (lost/rotated).' })
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.assertEnabled();
    return this.devices.revoke(user, id, body?.reason);
  }

  @Post('devices/:id/report-lost')
  @ApiOperation({ summary: 'Report a device lost/stolen (revokes + distinct audit).' })
  reportLost(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    this.assertEnabled();
    return this.devices.reportLost(user, id, body?.reason);
  }

  @Get('devices')
  @ApiOperation({ summary: 'List check-in devices for an organization.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('eventId') eventId?: string,
  ) {
    this.assertEnabled();
    return this.devices.list(user, organizationId, eventId);
  }

  @Get('manifest')
  @ApiOperation({ summary: 'Build + sign the offline manifest for a session.' })
  build(@CurrentUser() user: RequestUser, @Query('eventSessionId') eventSessionId: string) {
    this.assertEnabled();
    return this.manifest.build(user, eventSessionId);
  }

  @Post('reconcile')
  @ApiOperation({ summary: 'Reconcile a device’s queued offline check-ins (server wins).' })
  reconcile(
    @CurrentUser() user: RequestUser,
    @Body() body: { deviceId: string; checkIns: QueuedCheckIn[] },
  ) {
    this.assertEnabled();
    return this.reconciliation.reconcile(user, body.deviceId, body.checkIns ?? []);
  }

  @Get('deltas')
  @ApiOperation({ summary: 'Signed revocation delta since a version (incremental).' })
  deltas(
    @CurrentUser() user: RequestUser,
    @Query('eventSessionId') eventSessionId: string,
    @Query('sinceMs') sinceMs?: string,
  ) {
    this.assertEnabled();
    return this.manifest.buildDelta(user, eventSessionId, Number(sinceMs ?? 0) || 0);
  }

  @Post('drills')
  @ApiOperation({ summary: 'Record a live/browser certification drill result (manager).' })
  recordDrill(@CurrentUser() user: RequestUser, @Body() body: RecordDrillInput) {
    this.assertEnabled();
    return this.drills.record(user, body);
  }

  @Get('drills')
  @ApiOperation({ summary: 'List recent certification drill results for an organization.' })
  listDrills(@CurrentUser() user: RequestUser, @Query('organizationId') organizationId: string) {
    this.assertEnabled();
    return this.drills.list(user, organizationId);
  }

  @Get('offline-readiness')
  @ApiOperation({ summary: 'GO / CONDITIONAL_GO / NO_GO for offline gate check-in.' })
  offlineReadiness(
    @CurrentUser() _user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('eventSessionId') eventSessionId?: string,
  ) {
    return this.readiness.report(organizationId, eventSessionId);
  }

  @Get('activation')
  @ApiOperation({ summary: 'Strict activation launch gate (drills + admin decision required).' })
  activation(
    @CurrentUser() _user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('eventSessionId') eventSessionId?: string,
  ) {
    return this.readiness.activation(organizationId, eventSessionId);
  }

  @Post('activation/record')
  @ApiOperation({ summary: 'Record a scoped admin activation decision (manager/admin only).' })
  recordActivation(@CurrentUser() user: RequestUser, @Body() body: RecordActivationInput) {
    this.assertEnabled();
    return this.activations.record(user, body);
  }

  @Post('activation/:id/revoke')
  @ApiOperation({ summary: 'Revoke/downgrade an activation decision (manager/admin only).' })
  revokeActivation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.assertEnabled();
    return this.activations.revoke(user, id, body?.reason ?? '');
  }

  @Get('activation/decisions')
  @ApiOperation({ summary: 'List recorded activation decisions for an organization.' })
  listActivations(
    @CurrentUser() user: RequestUser,
    @Query('organizationId') organizationId: string,
  ) {
    this.assertEnabled();
    return this.activations.list(user, organizationId);
  }

  @Get('reconciliation')
  @ApiOperation({ summary: 'Reconciliation console: filtered + paginated ledger (staff read).' })
  reconciliationList(
    @CurrentUser() user: RequestUser,
    @Query() query: ReconciliationFilters & { page?: string; pageSize?: string },
  ) {
    this.assertEnabled();
    return this.reconciliationConsole.list(user, {
      ...query,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @Post('reconciliation/:id/resolve')
  @ApiOperation({ summary: 'Resolve a supervisor-review case (manager/admin, audit-only).' })
  resolveReconciliation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { action: ReconcileResolutionAction; reason: string },
  ) {
    this.assertEnabled();
    return this.reconciliationConsole.resolve(user, id, body?.action, body?.reason);
  }

  @Get('command-center')
  @ApiOperation({ summary: 'Live Event Command Center snapshot + alerts (staff read).' })
  commandCenterSnapshot(
    @CurrentUser() user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('eventSessionId') eventSessionId: string,
  ) {
    this.assertEnabled();
    return this.commandCenter.snapshot(user, organizationId, eventSessionId);
  }

  @Get('command-center/activity')
  @ApiOperation({ summary: 'Paginated recent offline operational activity (staff read).' })
  commandCenterActivity(
    @CurrentUser() user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    this.assertEnabled();
    return this.commandCenter.activity(
      user,
      organizationId,
      page ? Number(page) : undefined,
      pageSize ? Number(pageSize) : undefined,
    );
  }

  @Post('command-center/alerts/ack')
  @ApiOperation({ summary: 'Acknowledge a command-center alert (manager/admin, audited).' })
  acknowledgeAlert(@CurrentUser() user: RequestUser, @Body() body: AcknowledgeAlertInput) {
    this.assertEnabled();
    return this.commandCenter.acknowledgeAlert(user, body);
  }

  @Post('preflight')
  @ApiOperation({
    summary: 'Advisory device preflight checklist (staff read; never overrides rules).',
  })
  preflightChecklist(@CurrentUser() user: RequestUser, @Body() body: PreflightInput) {
    this.assertEnabled();
    return this.preflight.checklist(user, body);
  }
}
