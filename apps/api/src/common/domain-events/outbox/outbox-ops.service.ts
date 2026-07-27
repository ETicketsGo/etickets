import { Injectable } from '@nestjs/common';
import type { OutboxStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';

/** Safe metadata projection — never the payload, secrets, or PII. */
const SAFE_SELECT = {
  id: true,
  eventId: true,
  eventType: true,
  eventVersion: true,
  aggregateType: true,
  aggregateId: true,
  status: true,
  attemptCount: true,
  maxAttempts: true,
  availableAt: true,
  correlationId: true,
  causationId: true,
  deliveredAt: true,
  failedAt: true,
  lastErrorCode: true,
  createdAt: true,
} as const;

/**
 * Admin outbox operations (ADR-041 §22). RBAC-guarded at the controller; every mutating
 * action is audited. Returns SAFE metadata only (never payload/secrets/PII). No payload
 * editing and no identity/type changes — replaying is a controlled, audited action.
 */
@Injectable()
export class OutboxOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  list(status: OutboxStatus, limit = 100) {
    return this.prisma.outboxEvent.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limit, 500),
      select: SAFE_SELECT,
    });
  }

  inspect(id: string) {
    return this.prisma.outboxEvent.findUnique({ where: { id }, select: SAFE_SELECT });
  }

  aggregateHistory(aggregateType: string, aggregateId: string) {
    return this.prisma.outboxEvent.findMany({
      where: { aggregateType, aggregateId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: SAFE_SELECT,
    });
  }

  correlationChain(correlationId: string) {
    return this.prisma.outboxEvent.findMany({
      where: { correlationId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: SAFE_SELECT,
    });
  }

  /** Requeue one failed/dead-lettered/manual-review record (audited). */
  async retry(actorUserId: string | null, id: string): Promise<{ requeued: boolean }> {
    const res = await this.prisma.outboxEvent.updateMany({
      where: { id, status: { in: ['RETRYABLE_FAILURE', 'DEAD_LETTERED', 'MANUAL_REVIEW'] } },
      data: { status: 'PENDING', availableAt: new Date(), lockedBy: null, lockExpiresAt: null },
    });
    await this.audit.record({
      actorUserId,
      action: 'OUTBOX_RETRY',
      entityType: 'OutboxEvent',
      entityId: id,
    });
    this.metrics.recordOutboxOp('retry');
    return { requeued: res.count === 1 };
  }

  async retryBatch(
    actorUserId: string | null,
    status: OutboxStatus,
    limit = 50,
  ): Promise<{ requeued: number }> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { status },
      take: Math.min(limit, 500),
      select: { id: true },
    });
    for (const r of rows) {
      await this.prisma.outboxEvent.updateMany({
        where: { id: r.id, status },
        data: { status: 'PENDING', availableAt: new Date(), lockedBy: null, lockExpiresAt: null },
      });
    }
    await this.audit.record({
      actorUserId,
      action: 'OUTBOX_RETRY_BATCH',
      entityType: 'OutboxEvent',
      metadata: { status, count: rows.length },
    });
    this.metrics.recordOutboxOp('retry', rows.length);
    return { requeued: rows.length };
  }

  /** Cancel a record so it is never delivered (only if not already DELIVERED). */
  async cancel(actorUserId: string | null, id: string): Promise<{ cancelled: boolean }> {
    const res = await this.prisma.outboxEvent.updateMany({
      where: { id, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
      data: { status: 'CANCELLED', lockedBy: null, lockExpiresAt: null },
    });
    await this.audit.record({
      actorUserId,
      action: 'OUTBOX_CANCEL',
      entityType: 'OutboxEvent',
      entityId: id,
    });
    this.metrics.recordOutboxOp('cancel');
    return { cancelled: res.count === 1 };
  }

  async markManualReview(actorUserId: string | null, id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'MANUAL_REVIEW', lockedBy: null, lockExpiresAt: null },
    });
    await this.audit.record({
      actorUserId,
      action: 'OUTBOX_MANUAL_REVIEW',
      entityType: 'OutboxEvent',
      entityId: id,
    });
    this.metrics.recordOutboxOp('manual_review');
  }

  async releaseStaleLeases(actorUserId: string | null): Promise<{ recovered: number }> {
    const recovered = await this.dispatcher.recoverStaleLeases();
    await this.audit.record({
      actorUserId,
      action: 'OUTBOX_STALE_RECOVERY',
      entityType: 'OutboxEvent',
      metadata: { recovered },
    });
    return { recovered };
  }
}
