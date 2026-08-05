import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';

export interface OutboxPurgeResult {
  deliveredPurged: number;
  deadLetterPurged: number;
  idempotencyPurged: number;
}

/**
 * Bounded, audited retention (ADR-041 §23). Purges DELIVERED rows past the delivered
 * retention window and DEAD_LETTERED rows past their (longer) window. NEVER purges
 * MANUAL_REVIEW or un-resolved work under the delivered policy. Completed idempotency
 * records are pruned alongside delivered events. OFF by default
 * (DOMAIN_EVENT_OUTBOX_RETENTION_ENABLED). Safe under concurrent dispatch (only terminal
 * rows are eligible).
 */
@Injectable()
export class OutboxRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async purge(now: Date = new Date()): Promise<OutboxPurgeResult> {
    if (this.config.get<boolean>('DOMAIN_EVENT_OUTBOX_RETENTION_ENABLED') !== true) {
      return { deliveredPurged: 0, deadLetterPurged: 0, idempotencyPurged: 0 };
    }
    const deliveredDays = this.config.get<number>('DOMAIN_EVENT_OUTBOX_RETENTION_DAYS', 30);
    const deadLetterDays = this.config.get<number>(
      'DOMAIN_EVENT_OUTBOX_DEAD_LETTER_RETENTION_DAYS',
      90,
    );
    const deliveredCutoff = new Date(now.getTime() - deliveredDays * 86_400_000);
    const deadLetterCutoff = new Date(now.getTime() - deadLetterDays * 86_400_000);

    const delivered = await this.prisma.outboxEvent.deleteMany({
      where: { status: 'DELIVERED', deliveredAt: { lt: deliveredCutoff } },
    });
    const deadLetter = await this.prisma.outboxEvent.deleteMany({
      where: { status: 'DEAD_LETTERED', failedAt: { lt: deadLetterCutoff } },
    });
    const idempotency = await this.prisma.processedDomainEvent.deleteMany({
      where: { status: 'COMPLETED', processedAt: { lt: deliveredCutoff } },
    });

    this.metrics.recordOutboxOp('purge', delivered.count + deadLetter.count);
    return {
      deliveredPurged: delivered.count,
      deadLetterPurged: deadLetter.count,
      idempotencyPurged: idempotency.count,
    };
  }
}
