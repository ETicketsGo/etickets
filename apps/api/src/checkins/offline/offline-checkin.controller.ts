import { Body, Controller, Get, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { QueuedCheckIn } from '@eticketsgo/shared-types';
import { OfflineManifestService } from './offline-manifest.service';
import { CheckInDeviceService, type RegisterDeviceInput } from './checkin-device.service';
import { OfflineReconciliationService } from './offline-reconciliation.service';
import { OfflineCheckinReadinessService } from './offline-readiness.service';
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

  @Post('devices/:id/revoke')
  @ApiOperation({ summary: 'Revoke a device (lost/rotated).' })
  revoke(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    this.assertEnabled();
    return this.devices.revoke(user, id);
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

  @Get('offline-readiness')
  @ApiOperation({ summary: 'GO / CONDITIONAL_GO / NO_GO for offline gate check-in.' })
  offlineReadiness(
    @CurrentUser() _user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('eventSessionId') eventSessionId?: string,
  ) {
    return this.readiness.report(organizationId, eventSessionId);
  }
}
