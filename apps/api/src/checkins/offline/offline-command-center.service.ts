import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CheckInDeviceStatus,
  Role,
  TicketStatus,
  deriveCommandCenterAlerts,
  type AlertSeverity,
  type CommandCenterAlert,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { OfflineCheckinReadinessService } from './offline-readiness.service';
import { OfflineActivationService } from './offline-activation.service';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];
const MANAGER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** A device is "online" if it reconciled within this window; otherwise offline. */
const ONLINE_WINDOW_MS = 5 * 60_000;
const RECENT_SYNC_SAMPLE = 200;
const ACTIVITY_PAGE_SIZE = 20;
const MAX_ACTIVITY_PAGE_SIZE = 100;
const DEVICE_LIST_CAP = 100;

const OFFLINE_ACTIONS = [
  'OFFLINE_MANIFEST_ISSUED',
  'CHECKIN_DEVICE_REGISTERED',
  'CHECKIN_DEVICE_APPROVED',
  'CHECKIN_DEVICE_REVOKED',
  'OFFLINE_CHECKIN_RECONCILED',
  'OFFLINE_DRILL_RECORDED',
  'OFFLINE_ACTIVATION_RECORDED',
  'OFFLINE_ACTIVATION_REVOKED',
  'OFFLINE_RECONCILIATION_RESOLVED',
  'OFFLINE_ALERT_ACKNOWLEDGED',
];

const DUPLICATE_OUTCOMES = ['DUPLICATE_SAME_DEVICE', 'DUPLICATE_OTHER_DEVICE'];
const REJECTED_OUTCOMES = [
  'REVOKED_AFTER_DOWNLOAD',
  'REFUNDED_AFTER_DOWNLOAD',
  'TRANSFERRED_AFTER_DOWNLOAD',
  'WRONG_SESSION',
  'ALREADY_CHECKED_IN_ONLINE',
];

export interface AcknowledgeAlertInput {
  organizationId: string;
  eventSessionId: string;
  alertKey: string;
  severity: AlertSeverity;
  reason: string;
}

/**
 * Live Event Command Center (ADR-035). Composes a bounded, read-only operational
 * snapshot for one event session from the EXISTING activation, readiness, device,
 * reconciliation, attendance and audit data — never duplicating or admitting anything.
 * Alerts are derived deterministically (pure) and deduped by key; only manager/admin
 * acknowledgements are persisted, and they never suppress the underlying condition.
 */
@Injectable()
export class OfflineCommandCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly readiness: OfflineCheckinReadinessService,
    private readonly activations: OfflineActivationService,
  ) {}

  async snapshot(user: RequestUser, organizationId: string, eventSessionId: string) {
    await this.access.assertMember(user, organizationId, STAFF_ROLES);
    const now = Date.now();

    // Scope devices to THIS event (the session's event); records are session-scoped.
    const session = await this.prisma.eventSession.findUnique({
      where: { id: eventSessionId },
      select: { event: { select: { id: true, organizationId: true } } },
    });
    if (!session || session.event.organizationId !== organizationId) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Session not found in this organization.',
        HttpStatus.NOT_FOUND,
      );
    }
    const eventId = session.event.id;

    // Bounded, parallel aggregation — no N+1, no unbounded scans.
    const [
      activation,
      diagnostics,
      devices,
      latestManifest,
      totalTickets,
      admittedTickets,
      outcomeGroups,
      pendingReviews,
      recentSync,
      acks,
    ] = await Promise.all([
      this.readiness.activation(organizationId, eventSessionId),
      this.activations.diagnostics(organizationId, eventSessionId),
      this.prisma.checkInDevice.findMany({
        where: { organizationId, eventId },
        orderBy: { updatedAt: 'desc' },
        take: DEVICE_LIST_CAP,
      }),
      this.prisma.checkInManifest.findFirst({
        where: { eventSessionId },
        orderBy: { version: 'desc' },
      }),
      this.prisma.ticket.count({ where: { eventSessionId } }),
      this.prisma.ticket.count({ where: { eventSessionId, status: TicketStatus.CHECKED_IN } }),
      this.prisma.offlineReconciliationRecord.groupBy({
        by: ['outcome'],
        where: { eventSessionId },
        _count: { _all: true },
      }),
      this.prisma.offlineReconciliationRecord.count({
        where: { eventSessionId, reviewState: 'PENDING' },
      }),
      this.prisma.offlineReconciliationRecord.findMany({
        where: { eventSessionId },
        orderBy: { reconciledAt: 'desc' },
        take: RECENT_SYNC_SAMPLE,
        select: { localScannedAt: true, reconciledAt: true },
      }),
      this.prisma.offlineAlertAck.findMany({ where: { eventSessionId } }),
    ]);

    // Devices — counts by lifecycle + online/offline (bounded list already fetched).
    const deviceCounts = {
      total: devices.length,
      pending: 0,
      active: 0,
      suspended: 0,
      revoked: 0,
      expired: 0,
      online: 0,
      offline: 0,
    };
    for (const d of devices) {
      const key = d.status.toLowerCase() as keyof typeof deviceCounts;
      if (key in deviceCounts) deviceCounts[key] += 1;
      const expired = d.expiresAt ? d.expiresAt.getTime() <= now : false;
      if (d.status === CheckInDeviceStatus.ACTIVE && !expired) {
        const online = d.lastSeenAt ? now - d.lastSeenAt.getTime() <= ONLINE_WINDOW_MS : false;
        if (online) deviceCounts.online += 1;
        else deviceCounts.offline += 1;
      }
    }
    const deviceList = devices.slice(0, 50).map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      manifestVersion: d.manifestVersion,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    }));

    // Reconciliation outcome counts.
    const counts: Record<string, number> = {};
    for (const g of outcomeGroups) counts[g.outcome] = g._count._all;
    const totalScans = Object.values(counts).reduce((a, b) => a + b, 0);
    const acceptedCount = counts.ACCEPTED ?? 0;
    const duplicateCount = DUPLICATE_OUTCOMES.reduce((a, o) => a + (counts[o] ?? 0), 0);
    const rejectedCount = REJECTED_OUTCOMES.reduce((a, o) => a + (counts[o] ?? 0), 0);
    const reviewCount = counts.SUPERVISOR_REVIEW_REQUIRED ?? 0;

    // Sync latency (server reconcile time − device scan time) over a bounded sample.
    let latSum = 0;
    let latMax = 0;
    for (const r of recentSync) {
      const lat = r.reconciledAt.getTime() - r.localScannedAt.getTime();
      if (lat >= 0) {
        latSum += lat;
        if (lat > latMax) latMax = lat;
      }
    }
    const syncLatency = {
      sampleSize: recentSync.length,
      avgMs: recentSync.length ? Math.round(latSum / recentSync.length) : null,
      maxMs: recentSync.length ? latMax : null,
    };

    // Queue-growth proxy: the least-recently-seen ACTIVE device.
    const activeSeen = devices
      .filter((d) => d.status === CheckInDeviceStatus.ACTIVE && d.lastSeenAt)
      .map((d) => d.lastSeenAt!.getTime());
    const oldestActiveDeviceUnseenMs = activeSeen.length ? now - Math.min(...activeSeen) : null;

    // Revoked/expired device activity: reconciliations from non-active devices.
    const inactiveIds = devices
      .filter((d) => d.status !== CheckInDeviceStatus.ACTIVE)
      .map((d) => d.id);
    const revokedDeviceActivityCount = inactiveIds.length
      ? await this.prisma.offlineReconciliationRecord.count({
          where: { eventSessionId, deviceId: { in: inactiveIds } },
        })
      : 0;

    const manifestStale = !latestManifest || latestManifest.expiresAt.getTime() <= now;

    // Derive alerts (pure, deterministic, deduped) and enrich with ack state.
    const ackByKey = new Map(acks.map((a) => [a.alertKey, a]));
    const derived: CommandCenterAlert[] = deriveCommandCenterAlerts({
      eventSessionId,
      verdict: activation.verdict,
      hasActivationDecision: diagnostics.hasDecision,
      downgradeActive: diagnostics.downgradeActive,
      downgradeReasons: diagnostics.downgradeReasons,
      manifestStale,
      activeDeviceCount: deviceCounts.online + deviceCounts.offline,
      revokedDeviceActivityCount,
      totalScans,
      duplicateCount,
      pendingReviewCount: pendingReviews,
      syncFailureCount: 0, // not server-observable; reserved for when data supports it
      oldestActiveDeviceUnseenMs,
    });
    const alerts = derived.map((a) => {
      const ack = ackByKey.get(a.key);
      return {
        ...a,
        acknowledged: !!ack,
        acknowledgedAt: ack ? ack.acknowledgedAt.toISOString() : null,
        acknowledgedByUserId: ack ? ack.acknowledgedByUserId : null,
        acknowledgeReason: ack ? ack.reason : null,
      };
    });

    return {
      generatedAt: new Date(now).toISOString(),
      activation: { verdict: activation.verdict, checks: activation.checks, note: activation.note },
      downgrade: diagnostics,
      devices: { counts: deviceCounts, list: deviceList },
      manifest: {
        version: latestManifest?.version ?? null,
        stale: manifestStale,
        expiresAt: latestManifest ? latestManifest.expiresAt.toISOString() : null,
      },
      attendance: {
        total: totalTickets,
        admitted: admittedTickets,
        remaining: Math.max(0, totalTickets - admittedTickets),
        admissionRate: totalTickets ? Math.round((admittedTickets / totalTickets) * 100) : 0,
      },
      reconciliation: {
        totalScans,
        accepted: acceptedCount,
        duplicates: duplicateCount,
        rejected: rejectedCount,
        review: reviewCount,
        pendingReviews,
      },
      sync: {
        latency: syncLatency,
        oldestActiveDeviceUnseenMs,
        note: 'Live queue depth is client-side; sync latency/last-seen are server-derived.',
      },
      alerts,
    };
  }

  /** Bounded, paginated recent offline operational activity (audit-backed). */
  async activity(
    user: RequestUser,
    organizationId: string,
    page = 1,
    pageSize = ACTIVITY_PAGE_SIZE,
  ) {
    await this.access.assertMember(user, organizationId, STAFF_ROLES);
    const p = Math.max(1, Math.floor(page));
    const size = Math.min(MAX_ACTIVITY_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
    const where = { organizationId, action: { in: OFFLINE_ACTIONS } };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * size,
        take: size,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
          actor: { select: { email: true } },
        },
      }),
    ]);
    return { data, meta: { page: p, pageSize: size, total, totalPages: Math.ceil(total / size) } };
  }

  /**
   * Acknowledges an alert (manager/admin, requires a reason, audited). Idempotent per
   * (session, alertKey). Acknowledgement is a record only — it never suppresses the
   * underlying condition (which keeps deriving) or changes any gate state.
   */
  async acknowledgeAlert(user: RequestUser, input: AcknowledgeAlertInput) {
    await this.access.assertMember(user, input.organizationId, MANAGER_ROLES);
    if (!input.alertKey?.trim()) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An alert key is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!input.reason?.trim()) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A reason is required to acknowledge an alert.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const ack = await this.prisma.offlineAlertAck.upsert({
      where: {
        eventSessionId_alertKey: {
          eventSessionId: input.eventSessionId,
          alertKey: input.alertKey,
        },
      },
      create: {
        organizationId: input.organizationId,
        eventSessionId: input.eventSessionId,
        alertKey: input.alertKey,
        severityAtAck: input.severity,
        reason: input.reason.trim(),
        acknowledgedByUserId: user.id,
      },
      update: {
        reason: input.reason.trim(),
        severityAtAck: input.severity,
        acknowledgedByUserId: user.id,
        acknowledgedAt: new Date(),
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: input.organizationId,
      action: 'OFFLINE_ALERT_ACKNOWLEDGED',
      entityType: 'OfflineAlertAck',
      entityId: ack.id,
      metadata: {
        alertKey: input.alertKey,
        eventSessionId: input.eventSessionId,
        severity: input.severity,
      },
    });
    return ack;
  }
}
