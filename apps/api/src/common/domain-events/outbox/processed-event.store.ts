import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export type ProcessedClaim = 'CLAIMED' | 'ALREADY_COMPLETED' | 'IN_PROGRESS';

/**
 * Durable per-handler idempotency (ADR-041), backed by the unique
 * (eventId, handlerName) row. Replaces the in-memory P2 seam for the durable path:
 *
 * - `claim` atomically wins the right to run a handler once. A brand-new pair inserts
 *   PROCESSING (CLAIMED); an existing COMPLETED short-circuits (ALREADY_COMPLETED); an
 *   existing FAILED is re-claimed for retry (CLAIMED); anything else is IN_PROGRESS
 *   (another worker holds it) so the caller retries later. Under a concurrent race the
 *   unique constraint guarantees exactly one CLAIMED.
 */
@Injectable()
export class ProcessedEventStore {
  constructor(private readonly prisma: PrismaService) {}

  async claim(eventId: string, handlerName: string): Promise<ProcessedClaim> {
    try {
      await this.prisma.processedDomainEvent.create({
        data: { eventId, handlerName, status: 'PROCESSING' },
      });
      return 'CLAIMED';
    } catch (err) {
      if (!this.isUnique(err)) throw err;
      // Row exists — re-claim a previously FAILED attempt atomically.
      const reclaimed = await this.prisma.processedDomainEvent.updateMany({
        where: { eventId, handlerName, status: 'FAILED' },
        data: { status: 'PROCESSING', attemptCount: { increment: 1 } },
      });
      if (reclaimed.count === 1) return 'CLAIMED';
      const cur = await this.prisma.processedDomainEvent.findUnique({
        where: { eventId_handlerName: { eventId, handlerName } },
        select: { status: true },
      });
      return cur?.status === 'COMPLETED' ? 'ALREADY_COMPLETED' : 'IN_PROGRESS';
    }
  }

  async markCompleted(eventId: string, handlerName: string): Promise<void> {
    await this.prisma.processedDomainEvent.updateMany({
      where: { eventId, handlerName },
      data: { status: 'COMPLETED', processedAt: new Date(), lastErrorCode: null },
    });
  }

  async markFailed(eventId: string, handlerName: string, errorCode?: string): Promise<void> {
    await this.prisma.processedDomainEvent.updateMany({
      where: { eventId, handlerName },
      data: { status: 'FAILED', lastErrorCode: errorCode?.slice(0, 100) ?? null },
    });
  }

  async isCompleted(eventId: string, handlerName: string): Promise<boolean> {
    const row = await this.prisma.processedDomainEvent.findUnique({
      where: { eventId_handlerName: { eventId, handlerName } },
      select: { status: true },
    });
    return row?.status === 'COMPLETED';
  }

  private isUnique(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }
}
