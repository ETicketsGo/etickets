import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';

export type SyncReconcileClass =
  | 'IN_SYNC'
  | 'AUTO_REPAIRABLE'
  | 'PROVIDER_REFRESH_REQUIRED'
  | 'ETICKETSGO_REPAIR_REQUIRED'
  | 'MAPPING_REVIEW_REQUIRED'
  | 'BOOKING_REVIEW_REQUIRED'
  | 'MANUAL_REVIEW';

export interface SyncReconcileMismatch {
  class: SyncReconcileClass;
  providerCode: string;
  detail: string;
  reference?: string;
  repaired: boolean;
}

export interface SyncReconcileResult {
  scanned: number;
  mismatches: SyncReconcileMismatch[];
  autoRepaired: number;
  manualReviewRequired: number;
}

/**
 * Provider-neutral sync reconciliation (ADR-040 §19). Bounded scan that compares
 * ETicketsGo canonical state (mappings, imported state, event backlog, checkpoints)
 * with what the provider stream implies, and CLASSIFIES drift. It only auto-repairs
 * unambiguous cases (gated by INVENTORY_SYNC_AUTO_REPAIR_ENABLED) and NEVER auto-cancels
 * or refunds a confirmed customer booking — booking conflicts enter a protected review
 * class. Not a scheduled repair platform (deferred).
 */
@Injectable()
export class SyncReconciliationService {
  private readonly logger = new Logger('SyncReconcile');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async reconcile(
    req: { providerCode?: string; limit?: number } = {},
  ): Promise<SyncReconcileResult> {
    const limit = Math.min(req.limit ?? 200, 1000);
    const providerFilter = req.providerCode ? { providerCode: req.providerCode } : {};
    const mismatches: SyncReconcileMismatch[] = [];

    // 1) Mappings that need a human (never guessed).
    const mappings = await this.prisma.providerMapping.findMany({
      where: { ...providerFilter, status: { in: ['UNMAPPED', 'AMBIGUOUS', 'MANUAL_REVIEW'] } },
      take: limit,
      select: {
        providerCode: true,
        externalEntityType: true,
        externalEntityId: true,
        status: true,
      },
    });
    for (const m of mappings) {
      mismatches.push({
        class: 'MAPPING_REVIEW_REQUIRED',
        providerCode: m.providerCode,
        detail: `mapping ${m.status} for ${m.externalEntityType}`,
        reference: m.externalEntityId,
        repaired: false,
      });
    }

    // 2) Terminally-failed / review events. Booking/refund events escalate to booking review.
    const stuck = await this.prisma.rawProviderEvent.findMany({
      where: {
        ...providerFilter,
        processingStatus: { in: ['DEAD_LETTERED', 'MANUAL_REVIEW', 'PERMANENT_FAILURE'] },
      },
      take: limit,
      select: { providerCode: true, eventType: true, id: true },
    });
    for (const e of stuck) {
      const bookingRelated = /booking|refund/i.test(e.eventType);
      mismatches.push({
        class: bookingRelated ? 'BOOKING_REVIEW_REQUIRED' : 'MANUAL_REVIEW',
        providerCode: e.providerCode,
        detail: `terminal event ${e.eventType}`,
        reference: e.id,
        repaired: false,
      });
    }

    // 3) Stale checkpoints (provider refresh needed).
    const stale = await this.prisma.providerSyncCheckpoint.findMany({
      where: { ...providerFilter, failureCount: { gte: 5 } },
      take: limit,
      select: { providerCode: true, resource: true },
    });
    for (const c of stale) {
      mismatches.push({
        class: 'PROVIDER_REFRESH_REQUIRED',
        providerCode: c.providerCode,
        detail: `checkpoint failing: ${c.resource}`,
        repaired: false,
      });
    }

    const manualReviewRequired = mismatches.filter(
      (m) =>
        m.class === 'MAPPING_REVIEW_REQUIRED' ||
        m.class === 'BOOKING_REVIEW_REQUIRED' ||
        m.class === 'MANUAL_REVIEW',
    ).length;
    this.metrics.recordSyncReconcile('mismatch', mismatches.length);
    this.metrics.recordSyncReconcile('manual_review', manualReviewRequired);
    if (mismatches.length > 0) {
      this.logger.warn(
        `reconcile found ${mismatches.length} mismatch(es), ${manualReviewRequired} need review`,
      );
    }
    // No unambiguous auto-repairs are defined for P4 (documented); gate is respected.
    const autoRepairEnabled =
      this.config.get<boolean>('INVENTORY_SYNC_AUTO_REPAIR_ENABLED') === true;
    void autoRepairEnabled;

    return {
      scanned: mappings.length + stuck.length + stale.length,
      mismatches,
      autoRepaired: 0,
      manualReviewRequired,
    };
  }
}
