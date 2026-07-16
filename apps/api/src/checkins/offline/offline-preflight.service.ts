import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Role,
  buildPreflightChecks,
  derivePreflightVerdict,
  PREFLIGHT_CLOCK_TOLERANCE_MS,
  PREFLIGHT_DELTA_WINDOW_MS,
  type PreflightSignals,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { CheckInDeviceService } from './checkin-device.service';
import { OfflineCommandCenterService } from './offline-command-center.service';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

export interface PreflightInput {
  organizationId: string;
  eventSessionId: string;
  deviceId: string;
  /** Client-reported device state (the device runs its own preflight). */
  clientManifestVersion?: number;
  clientTimeMs?: number;
  queueDepth?: number;
  syncFailureCount?: number;
}

/**
 * Offline preflight checklist (ADR-035) — an ADVISORY, device-scoped readiness view.
 * It REUSES the command-center snapshot (activation verdict, manifest freshness,
 * pending reviews, critical alerts) + the device record, and never re-derives or
 * overrides any readiness/activation rule. Read-only; the server stays authoritative.
 */
@Injectable()
export class OfflinePreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly devices: CheckInDeviceService,
    private readonly commandCenter: OfflineCommandCenterService,
  ) {}

  async checklist(user: RequestUser, input: PreflightInput) {
    await this.access.assertMember(user, input.organizationId, STAFF_ROLES);

    const [device, session] = await Promise.all([
      this.prisma.checkInDevice.findUnique({ where: { id: input.deviceId } }),
      this.prisma.eventSession.findUnique({
        where: { id: input.eventSessionId },
        select: { event: { select: { id: true, organizationId: true } } },
      }),
    ]);
    if (!device || device.organizationId !== input.organizationId) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Device not found in this organization.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!session || session.event.organizationId !== input.organizationId) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Session not found in this organization.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Reuse the command-center diagnostics — no readiness logic is duplicated here.
    const snapshot = await this.commandCenter.snapshot(
      user,
      input.organizationId,
      input.eventSessionId,
    );

    const now = Date.now();
    const deviceInScope =
      device.eventId === session.event.id &&
      (!device.eventSessionId || device.eventSessionId === input.eventSessionId);

    const signals: PreflightSignals = {
      deviceActive: this.devices.isOperational(device),
      deviceInScope,
      latestManifestVersion: snapshot.manifest.version,
      clientManifestVersion: input.clientManifestVersion ?? null,
      manifestFresh: !snapshot.manifest.stale,
      lastSeenMsAgo: device.lastSeenAt ? now - device.lastSeenAt.getTime() : null,
      deltaWindowMs: PREFLIGHT_DELTA_WINDOW_MS,
      clockSkewMs: input.clientTimeMs != null ? Math.abs(now - input.clientTimeMs) : null,
      clockToleranceMs: PREFLIGHT_CLOCK_TOLERANCE_MS,
      queueDepth: input.queueDepth ?? null,
      syncFailureCount: input.syncFailureCount ?? 0,
      pendingReviewCount: snapshot.reconciliation.pendingReviews,
      activationVerdict: snapshot.activation.verdict,
      criticalAlertCount: snapshot.alerts.filter((a) => a.severity === 'critical').length,
    };

    const checks = buildPreflightChecks(signals);
    return {
      generatedAt: new Date(now).toISOString(),
      deviceId: device.id,
      deviceName: device.name,
      eventSessionId: input.eventSessionId,
      verdict: derivePreflightVerdict(checks),
      checks,
    };
  }
}
