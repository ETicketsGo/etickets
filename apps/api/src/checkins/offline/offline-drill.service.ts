import { Injectable } from '@nestjs/common';
import { Prisma, type OfflineDrillKey, type OfflineDrillOutcome } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import type { RequestUser } from '../../common/decorators';

const MANAGER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];
const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

/**
 * Certification evidence older than this no longer certifies today's build — the
 * gate reverts to fail-closed for that drill (a drill run half a year ago must not
 * keep activation open). Generous enough that a freshly recorded drill always counts.
 */
export const DRILL_EVIDENCE_TTL_MS = 90 * 86_400_000;

export interface RecordDrillInput {
  organizationId: string;
  eventId?: string;
  eventSessionId?: string;
  drillKey: OfflineDrillKey;
  outcome: OfflineDrillOutcome;
  summary: string;
  evidence?: Prisma.InputJsonValue;
}

/** Which activation-gate drills currently have fresh PASS evidence (fail-closed). */
export interface DrillEvidence {
  twoDeviceDrillPassed: boolean;
  deviceLossDrillPassed: boolean;
  reconciliationDrillPassed: boolean;
}

/**
 * Records and reads offline certification drill results (ADR-035). The activation
 * launch gate consumes {@link DrillEvidence} instead of hardcoded assumptions: a
 * drill only counts when its latest run is a PASS within the freshness window.
 * Anything else — never run, last failed, or stale — keeps the gate closed.
 */
@Injectable()
export class OfflineDrillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Records a drill result. Recording is a certification action (manager only). */
  async record(user: RequestUser, input: RecordDrillInput) {
    await this.access.assertMember(user, input.organizationId, MANAGER_ROLES);
    const run = await this.prisma.offlineDrillRun.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId ?? null,
        eventSessionId: input.eventSessionId ?? null,
        drillKey: input.drillKey,
        outcome: input.outcome,
        summary: input.summary,
        evidence: input.evidence ?? Prisma.JsonNull,
        ranByUserId: user.id,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: input.organizationId,
      action: 'OFFLINE_DRILL_RECORDED',
      entityType: 'OfflineDrillRun',
      entityId: run.id,
      metadata: { drillKey: input.drillKey, outcome: input.outcome },
    });
    return run;
  }

  /** The most recent run per drill key for an org (any outcome, for the console). */
  async list(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId, STAFF_ROLES);
    const runs = await this.prisma.offlineDrillRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return runs;
  }

  /**
   * Fresh PASS evidence per activation-gate drill. Fail-closed: a drill counts only
   * when its single most-recent run is a PASS newer than the TTL. A later FAIL or a
   * stale PASS closes the gate for that drill.
   */
  async drillEvidence(organizationId: string, now = Date.now()): Promise<DrillEvidence> {
    const cutoff = new Date(now - DRILL_EVIDENCE_TTL_MS);
    const keys: OfflineDrillKey[] = ['TWO_DEVICE_CONFLICT', 'DEVICE_LOSS', 'RECONCILIATION'];
    const fresh: Record<string, boolean> = {};
    for (const key of keys) {
      const latest = await this.prisma.offlineDrillRun.findFirst({
        where: { organizationId, drillKey: key },
        orderBy: { createdAt: 'desc' },
        select: { outcome: true, createdAt: true },
      });
      fresh[key] = !!latest && latest.outcome === 'PASS' && latest.createdAt >= cutoff;
    }
    return {
      twoDeviceDrillPassed: fresh.TWO_DEVICE_CONFLICT,
      deviceLossDrillPassed: fresh.DEVICE_LOSS,
      reconciliationDrillPassed: fresh.RECONCILIATION,
    };
  }
}
