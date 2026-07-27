import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';

export type OutboxHealthState = 'DISABLED' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

export interface OutboxHealthReport {
  mode: string;
  dispatchEnabled: boolean;
  state: OutboxHealthState;
  pending: number;
  processing: number;
  retryable: number;
  deadLettered: number;
  manualReview: number;
  staleLease: number;
  oldestPendingAgeSeconds: number | null;
  lastDispatchAt: string | null;
  workerId: string;
}

/**
 * Outbox health (ADR-041 §19). Read-only API endpoints must not depend on this — only
 * booking readiness that genuinely requires durable delivery should. States: DISABLED
 * (in_process mode), UNHEALTHY (outbox mode but dispatcher off, or growing dead-letters),
 * DEGRADED (old pending backlog / stale leases), else HEALTHY.
 */
@Injectable()
export class OutboxHealthService {
  private readonly degradedAgeSeconds = 600;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  async report(): Promise<OutboxHealthReport> {
    const mode = this.config.get<string>('DOMAIN_EVENT_DELIVERY_MODE', 'in_process');
    const dispatchEnabled =
      this.config.get<boolean>('DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED') === true;
    const now = new Date();

    const [pending, processing, retryable, deadLettered, manualReview, staleLease, oldest] =
      await Promise.all([
        this.prisma.outboxEvent.count({ where: { status: 'PENDING', shadow: false } }),
        this.prisma.outboxEvent.count({ where: { status: 'PROCESSING' } }),
        this.prisma.outboxEvent.count({ where: { status: 'RETRYABLE_FAILURE' } }),
        this.prisma.outboxEvent.count({ where: { status: 'DEAD_LETTERED' } }),
        this.prisma.outboxEvent.count({ where: { status: 'MANUAL_REVIEW' } }),
        this.prisma.outboxEvent.count({
          where: { status: 'PROCESSING', lockExpiresAt: { lt: now } },
        }),
        this.prisma.outboxEvent.findFirst({
          where: { status: { in: ['PENDING', 'RETRYABLE_FAILURE'] }, shadow: false },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);

    const oldestPendingAgeSeconds = oldest
      ? Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1000)
      : null;
    const state = this.derive(mode, dispatchEnabled, {
      deadLettered,
      staleLease,
      oldestPendingAgeSeconds,
    });

    return {
      mode,
      dispatchEnabled,
      state,
      pending,
      processing,
      retryable,
      deadLettered,
      manualReview,
      staleLease,
      oldestPendingAgeSeconds,
      lastDispatchAt: this.dispatcher.lastDispatch
        ? new Date(this.dispatcher.lastDispatch).toISOString()
        : null,
      workerId: this.dispatcher.workerId,
    };
  }

  private derive(
    mode: string,
    dispatchEnabled: boolean,
    s: { deadLettered: number; staleLease: number; oldestPendingAgeSeconds: number | null },
  ): OutboxHealthState {
    if (mode === 'in_process') return 'DISABLED';
    if (!dispatchEnabled) return 'UNHEALTHY'; // recording durably but nothing delivers
    if (s.deadLettered > 0) return 'DEGRADED';
    if (s.staleLease > 0) return 'DEGRADED';
    if (s.oldestPendingAgeSeconds !== null && s.oldestPendingAgeSeconds > this.degradedAgeSeconds)
      return 'DEGRADED';
    return 'HEALTHY';
  }
}
