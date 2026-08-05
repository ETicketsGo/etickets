import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { deserializeEvent, type OutboxRowRead } from './outbox-serialization';
import { classifyOutboxFailure, nextAvailableAt } from './outbox-retry';
import { OUTBOX_DELIVERY_ADAPTER, type OutboxDeliveryAdapter } from './outbox-delivery.adapter';

interface ClaimedRow extends OutboxRowRead {
  id: string;
  attemptCount: number;
  maxAttempts: number;
}

export interface DispatchResult {
  claimed: number;
  delivered: number;
  failed: number;
}

/**
 * Outbox dispatcher (ADR-041 §8). Runs in the worker. Claims a batch atomically with
 * `FOR UPDATE SKIP LOCKED` (never an unprotected read-then-update), leases each row,
 * delivers via the adapter under durable per-handler idempotency, and drives the
 * terminal status by failure classification. Multiple workers share the table safely;
 * a crashed worker's lease expires and its rows are re-claimed. Same-aggregate events
 * are delivered in creation order (a `NOT EXISTS` guard), while different aggregates
 * process concurrently and a failing aggregate never blocks unrelated ones.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger('OutboxDispatcher');
  readonly workerId: string;
  private lastDispatchAt: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    @Inject(OUTBOX_DELIVERY_ADAPTER) private readonly adapter: OutboxDeliveryAdapter,
  ) {
    this.workerId =
      this.config.get<string>('DOMAIN_EVENT_OUTBOX_WORKER_ID') || `outbox-${randomUUID()}`;
  }

  private get enabled(): boolean {
    return this.config.get<boolean>('DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED') === true;
  }

  get lastDispatch(): number | null {
    return this.lastDispatchAt;
  }

  /** Claim + deliver one batch. No-op when dispatch is disabled. */
  async dispatchBatch(): Promise<DispatchResult> {
    if (!this.enabled) return { claimed: 0, delivered: 0, failed: 0 };
    const startedAt = Date.now();
    const batchSize = this.config.get<number>('DOMAIN_EVENT_OUTBOX_BATCH_SIZE', 100);
    const leaseSeconds = this.config.get<number>('DOMAIN_EVENT_OUTBOX_LEASE_SECONDS', 60);

    const rows = await this.claim(batchSize, leaseSeconds);
    this.metrics.recordOutboxClaimed(rows.length);
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      (await this.processRow(row)) ? (delivered += 1) : (failed += 1);
    }
    this.lastDispatchAt = Date.now();
    this.metrics.observeOutboxPoll((Date.now() - startedAt) / 1000);
    if (rows.length === 0) this.metrics.recordOutboxNoWorkPoll();
    return { claimed: rows.length, delivered, failed };
  }

  /**
   * Atomic claim: move eligible (or stale-leased) rows to PROCESSING and RETURN them.
   * `FOR UPDATE SKIP LOCKED` in the sub-select lets concurrent workers claim disjoint
   * rows. Same-aggregate ordering via the NOT EXISTS on earlier undelivered siblings.
   */
  private async claim(batchSize: number, leaseSeconds: number): Promise<ClaimedRow[]> {
    return this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      UPDATE "OutboxEvent" AS o
      SET status = 'PROCESSING', "lockedBy" = ${this.workerId}, "lockedAt" = now(),
          "lockExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'),
          "attemptCount" = o."attemptCount" + 1, "lastAttemptAt" = now(), "updatedAt" = now()
      WHERE o.id IN (
        SELECT c.id FROM "OutboxEvent" c
        WHERE c.shadow = false
          AND (
            (c.status IN ('PENDING','RETRYABLE_FAILURE') AND c."availableAt" <= now())
            OR (c.status = 'PROCESSING' AND c."lockExpiresAt" < now())
          )
          AND NOT EXISTS (
            SELECT 1 FROM "OutboxEvent" e
            WHERE e."aggregateType" = c."aggregateType"
              AND e."aggregateId" = c."aggregateId"
              AND e.status IN ('PENDING','PROCESSING','RETRYABLE_FAILURE')
              AND (e."createdAt" < c."createdAt" OR (e."createdAt" = c."createdAt" AND e.id < c.id))
          )
        ORDER BY c.priority DESC, c."createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id, o."eventId", o."eventType", o."eventVersion", o."aggregateType",
                o."aggregateId", o."occurredAt", o."correlationId", o."causationId",
                o."actorId", o."tenantId", o."payloadJson", o."metadataJson",
                o."attemptCount", o."maxAttempts"
    `);
  }

  /** Deliver one claimed row; returns true on DELIVERED, false on any failure. */
  private async processRow(row: ClaimedRow): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const event = deserializeEvent(row); // validates envelope + version
      await this.adapter.deliver(event); // throws retryable if handlers not all complete
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(),
          lockedBy: null,
          lockExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      this.metrics.recordOutboxDelivery(row.eventType, 'delivered');
      this.metrics.observeOutboxDeliveryLatency((Date.now() - startedAt) / 1000);
      return true;
    } catch (err) {
      await this.handleFailure(row, err);
      return false;
    }
  }

  private async handleFailure(row: ClaimedRow, err: unknown): Promise<void> {
    const verdict = classifyOutboxFailure(err);
    const code = (err as { code?: string })?.code ?? 'UNKNOWN';
    const message = (err instanceof Error ? err.message : 'unknown').slice(0, 500);

    let status: 'RETRYABLE_FAILURE' | 'DEAD_LETTERED' | 'MANUAL_REVIEW' = verdict.terminalStatus;
    let availableAt: Date | undefined;
    if (verdict.class === 'RETRYABLE') {
      if (row.attemptCount >= row.maxAttempts) {
        status = 'DEAD_LETTERED';
      } else {
        status = 'RETRYABLE_FAILURE';
        availableAt = nextAvailableAt(
          row.attemptCount,
          this.config.get<number>('DOMAIN_EVENT_OUTBOX_BASE_RETRY_SECONDS', 5),
          this.config.get<number>('DOMAIN_EVENT_OUTBOX_MAX_RETRY_SECONDS', 3600),
        );
      }
    }

    await this.prisma.outboxEvent.update({
      where: { id: row.id },
      data: {
        status,
        availableAt,
        failedAt: new Date(),
        lockedBy: null,
        lockExpiresAt: null,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    });
    this.metrics.recordOutboxDelivery(row.eventType, status.toLowerCase());
    this.logger.warn(
      `outbox ${row.id} (${row.eventType}) → ${status} class=${verdict.class} code=${code}`,
    );
  }

  /**
   * Belt-and-suspenders stale-lease recovery: reset PROCESSING rows whose lease has
   * expired back to retryable (the claim also picks these up). Returns rows recovered.
   */
  async recoverStaleLeases(): Promise<number> {
    const res = await this.prisma.outboxEvent.updateMany({
      where: { status: 'PROCESSING', lockExpiresAt: { lt: new Date() } },
      data: {
        status: 'RETRYABLE_FAILURE',
        availableAt: new Date(),
        lockedBy: null,
        lockExpiresAt: null,
      },
    });
    if (res.count > 0) this.metrics.recordOutboxStaleRecovery(res.count);
    return res.count;
  }
}
